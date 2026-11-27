//! 按事项与附件序号提供只读预览，不接受前端指定的磁盘路径。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use specta::Type;
use starat_application::error::{AppError, ErrorCode};
use starat_platform::open::OpenPort;
use tauri::{AppHandle, Runtime, State};

use crate::app::AppState;
use crate::dto::{IpcError, parse_item_id};
use crate::open::TauriOpen;

/// 图片预览最多读取 16 MiB，文本最多显示 512 KiB。
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
/// 文本预览的大小上限。
const MAX_TEXT_BYTES: usize = 512 * 1024;

/// 附件的只读预览结果。
#[derive(Debug, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AttachmentPreviewDto {
    /// 作为图片展示的栅格图像，不解释 HTML 或 SVG。
    Image {
        /// 带 MIME 的 Base64 图片地址。
        url: String,
    },
    /// 原样展示的文本，不执行其中的脚本或标记。
    Text {
        /// 文本内容。
        content: String,
    },
    /// 文件过大、格式不受支持或路径是文件夹。
    Unavailable,
}

/// 附件操作失败的统一错误。
fn failed(error: impl std::fmt::Display) -> IpcError {
    AppError::new(ErrorCode::SourceOpenFailed, error.to_string()).into()
}

/// 托管附件必须是附件目录下的文件，拒绝穿越和指向目录外的符号链接。
fn stored_path(root: &Path, name: &str) -> Result<PathBuf, IpcError> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || matches!(name, "." | "..") {
        return Err(failed("附件路径无效"));
    }
    let root = root.canonicalize().map_err(failed)?;
    let path = root.join(name).canonicalize().map_err(failed)?;
    if !path.starts_with(&root) {
        return Err(failed("附件不在应用附件目录内"));
    }
    Ok(path)
}

/// 只从已保存的事项附件记录解析目标。
async fn attachment_path(state: &AppState, id: &str, index: u32) -> Result<PathBuf, IpcError> {
    let detail = state
        .services
        .items
        .get_item_detail(parse_item_id(id)?)
        .await?;
    let attachment = detail
        .attachments
        .get(index as usize)
        .ok_or_else(|| failed("附件不存在"))?;
    let path = if attachment.owns_file() {
        let paths = state
            .runtime
            .paths()
            .ok_or_else(|| failed("应用目录尚未就绪"))?;
        stored_path(&paths.attachments_dir(), &attachment.path)?
    } else {
        PathBuf::from(&attachment.path)
    };
    if !path.exists() {
        return Err(AppError::new(ErrorCode::SourceFileMissing, "关联文件不存在").into());
    }
    Ok(path)
}

/// 从文件头识别可作为图片展示的格式。
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

/// 限量读取内容；所有文件都只以只读方式打开。
fn read_preview(path: &Path) -> Result<AttachmentPreviewDto, IpcError> {
    if path.is_dir() {
        return Ok(AttachmentPreviewDto::Unavailable);
    }
    let file = File::open(path).map_err(failed)?;
    let metadata = file.metadata().map_err(failed)?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Ok(AttachmentPreviewDto::Unavailable);
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(failed)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Ok(AttachmentPreviewDto::Unavailable);
    }
    if let Some(mime) = image_mime(&bytes) {
        return Ok(AttachmentPreviewDto::Image {
            url: format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        });
    }
    if bytes.len() <= MAX_TEXT_BYTES {
        let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
            let little_endian = bytes[0] == 0xff;
            if bytes.len() % 2 != 0 {
                return Ok(AttachmentPreviewDto::Unavailable);
            }
            let units: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|pair| {
                    if little_endian {
                        u16::from_le_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_be_bytes([pair[0], pair[1]])
                    }
                })
                .collect();
            String::from_utf16(&units).ok()
        } else {
            String::from_utf8(bytes).ok()
        };
        if let Some(content) = text.filter(|text| !text.contains('\0')) {
            return Ok(AttachmentPreviewDto::Text { content });
        }
    }
    Ok(AttachmentPreviewDto::Unavailable)
}

/// 查看一个已关联附件的图片或文本内容。
///
/// # Errors
/// 事项 / 附件不存在、文件已丢失或无法读取时返回错误。
#[tauri::command]
#[specta::specta]
pub async fn preview_item_attachment(
    state: State<'_, AppState>,
    id: String,
    index: u32,
) -> Result<AttachmentPreviewDto, IpcError> {
    let path = attachment_path(&state, &id, index).await?;
    tokio::task::spawn_blocking(move || read_preview(&path))
        .await
        .map_err(failed)?
}

/// 在文件管理器中定位指定关联附件（包括 StarAt 保存的截图）。
///
/// # Errors
/// 事项 / 附件不存在、文件已丢失或系统定位失败时返回错误。
#[tauri::command]
#[specta::specta]
pub async fn reveal_item_attachment<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: String,
    index: u32,
) -> Result<(), IpcError> {
    let path = attachment_path(&state, &id, index).await?;
    TauriOpen::new(app)
        .reveal_file(&path.to_string_lossy())
        .map_err(failed)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn preview_preserves_text_and_handles_images_binary_missing_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, "<script>只作为文字展示</script>").unwrap();
        assert!(
            matches!(read_preview(&path).unwrap(), AttachmentPreviewDto::Text { content } if content.contains("<script>"))
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "<script>只作为文字展示</script>"
        );
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(
            matches!(read_preview(&path).unwrap(), AttachmentPreviewDto::Image { url } if url.starts_with("data:image/png;base64,"))
        );
        std::fs::write(&path, [0, 1, 2]).unwrap();
        assert!(matches!(
            read_preview(&path).unwrap(),
            AttachmentPreviewDto::Unavailable
        ));
        std::fs::write(&path, [0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]).unwrap();
        assert!(
            matches!(read_preview(&path).unwrap(), AttachmentPreviewDto::Text { content } if content == "中文")
        );
        std::fs::write(&path, vec![b'a'; MAX_TEXT_BYTES + 1]).unwrap();
        assert!(matches!(
            read_preview(&path).unwrap(),
            AttachmentPreviewDto::Unavailable
        ));
        File::create(&path)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert!(matches!(
            read_preview(&path).unwrap(),
            AttachmentPreviewDto::Unavailable
        ));
        assert!(matches!(
            read_preview(dir.path()).unwrap(),
            AttachmentPreviewDto::Unavailable
        ));
        assert!(read_preview(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn stored_attachment_cannot_escape_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["../secret", "..\\secret", "C:secret", "/secret", "..", ""] {
            assert!(stored_path(dir.path(), name).is_err());
        }
        std::fs::write(dir.path().join("image.png"), b"test").unwrap();
        assert!(
            stored_path(dir.path(), "image.png")
                .unwrap()
                .starts_with(dir.path().canonicalize().unwrap())
        );
    }
}
