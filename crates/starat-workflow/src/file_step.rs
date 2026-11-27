//! `readFile` Step：读取输入里被拖入的文件，提取文档标题（实施计划 6.6）。
//!
//! 安全边界：路径只来自 Workflow 输入里的文件，Step 没有「指定路径」的参数；
//! 大小上限与阻塞线程池由 [`FileInspector`] 实现负责。
//!
//! 一次拖入多个文件时**逐个读取**：每个文件的结果写进它自己的变量（`forEach: files` 渲染第 i 个
//! 文件时用第 i 份），第一个文件的结果同时写进公共变量表——和 `file.*` 取第一个文件的约定一致。
//! 认不出标题的种类（[`DocKind::Other`]）不读内容：读了也提取不出什么，白白占用 IO。
//!
//! 只读取标题需要的部分（[`DocKind::read_plan`]）：文本类读开头 256 KiB，PDF 小文件整个读、大文件读头尾，
//! Office / OpenDocument / EPUB 只读 zip 目录和元数据条目——文件再大也只读几百 KB，
//! 所以大文件也能拿到标题，拖放不会因为读文件而变慢。多个文件同时读几个。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use starat_application::ports::inspect::{FileInspector, InspectError};
use starat_domain::capture::FileRef;
use starat_domain::workflow::Step;

use crate::doc_meta::{
    DocKind, PDF_EDGE_BYTES, PDF_WHOLE_BYTES, ReadPlan, title_from_entry, title_of, zip_index,
};
use crate::executor::{RunContext, StepError, StepExecutor, step_kind};

/// `readFile` 的执行器。
pub struct ReadFileExecutor {
    /// 文件检查 Port。
    port: Arc<dyn FileInspector>,
}

impl ReadFileExecutor {
    /// 创建执行器。
    #[must_use]
    pub fn new(port: Arc<dyn FileInspector>) -> Self {
        Self { port }
    }
}

/// 同时读几个文件（多文件拖入时）。
const PARALLEL_READS: usize = 4;

/// 按种类读需要的部分并提取标题；返回 `(标题, 大小)`。读不出标题是空串，不是错误。
async fn title_and_size(
    port: &dyn FileInspector,
    file: &FileRef,
    kind: DocKind,
) -> Result<(String, u64), InspectError> {
    if kind.read_plan() == ReadPlan::Nothing {
        // 不读内容；捕获时就探测不到大小（且不是文件夹）说明文件已经不在了。
        return match file.size_bytes {
            Some(size) => Ok((String::new(), size)),
            None if file.is_dir => Err(InspectError::Directory),
            None => Err(InspectError::Missing),
        };
    }
    let path = file.path.as_str();
    let size = port.stat(path).await?;
    let title = match kind.read_plan() {
        ReadPlan::Nothing => None,
        ReadPlan::Head(bytes) => title_of(kind, &port.read_at(path, 0, bytes).await?),
        ReadPlan::Pdf if size <= PDF_WHOLE_BYTES => {
            title_of(kind, &port.read_at(path, 0, size).await?)
        }
        ReadPlan::Pdf => {
            let mut bytes = port.read_at(path, 0, PDF_EDGE_BYTES).await?;
            bytes.extend(
                port.read_at(path, size - PDF_EDGE_BYTES, PDF_EDGE_BYTES)
                    .await?,
            );
            title_of(kind, &bytes)
        }
        ReadPlan::ZipEntry => zip_title(port, path, size, kind).await?,
    };
    Ok((title.unwrap_or_default(), size))
}

/// zip 容器：读末尾目录 → 目录 → 那一个条目，不读其余内容（见 [`zip_index`]）。
async fn zip_title(
    port: &dyn FileInspector,
    path: &str,
    size: u64,
    kind: DocKind,
) -> Result<Option<String>, InspectError> {
    let tail_offset = size.saturating_sub(zip_index::TAIL_BYTES);
    let tail = port
        .read_at(path, tail_offset, zip_index::TAIL_BYTES)
        .await?;
    let Some((offset, len)) = zip_index::directory_location(&tail, tail_offset) else {
        return Ok(None);
    };
    // 目录通常就在刚读的末尾里，不必再读一次。
    let directory = if offset >= tail_offset {
        let start = usize::try_from(offset - tail_offset).unwrap_or(usize::MAX);
        tail.get(start..).unwrap_or_default().to_vec()
    } else {
        port.read_at(path, offset, len.min(zip_index::MAX_DIRECTORY_BYTES))
            .await?
    };
    let Some(entry) = zip_index::find_entry(&directory, |name| kind.is_title_entry(name)) else {
        return Ok(None);
    };
    let header = port
        .read_at(
            path,
            entry.local_header_offset,
            zip_index::LOCAL_HEADER_BYTES,
        )
        .await?;
    let Some(start) = zip_index::data_offset(&entry, &header) else {
        return Ok(None);
    };
    // 压缩后的元数据条目不会比解压上限还大；更大的说明不是我们要的那种文件。
    let data = port
        .read_at(
            path,
            start,
            entry.compressed_size.min(zip_index::MAX_ENTRY_BYTES * 4),
        )
        .await?;
    Ok(zip_index::inflate(&entry, &data).and_then(|xml| title_from_entry(&xml)))
}

/// 读一个文件，返回 `(标题, 种类, 大小)`。
///
/// `optional` 时任何读取失败都得到空标题；否则文件不在原处是 `invalid`，其他失败是 `fatal`。
async fn read_one(
    port: &dyn FileInspector,
    file: &FileRef,
    optional: bool,
) -> Result<(String, DocKind, u64), StepError> {
    let kind = DocKind::from_extension(file.extension.as_deref().unwrap_or(""));
    match title_and_size(port, file, kind).await {
        Ok((title, size)) => Ok((title, kind, size)),
        Err(error) if optional => {
            tracing::debug!(event = "read_file_skipped", reason = %error, "可选的 readFile 被跳过");
            Ok((String::new(), kind, 0))
        }
        Err(InspectError::Missing) => Err(StepError::invalid("文件已经不在原来的位置了")),
        Err(error) => Err(StepError::fatal(error.to_string())),
    }
}

/// 把结果变量写进一张变量表。
fn put(scope: &mut HashMap<String, String>, into: &str, title: &str, kind: &str, size: u64) {
    scope.insert(format!("vars.{into}_title"), title.to_owned());
    scope.insert(format!("vars.{into}_kind"), kind.to_owned());
    scope.insert(format!("vars.{into}_size"), size.to_string());
}

#[async_trait]
impl StepExecutor for ReadFileExecutor {
    /// 种类。
    fn kind(&self) -> &'static str {
        "readFile"
    }

    /// 逐个读取并提取标题。
    async fn execute(&self, step: &Step, ctx: &mut RunContext<'_>) -> Result<(), StepError> {
        let Step::ReadFile { into, optional } = step else {
            return Err(StepError::fatal(format!(
                "Executor 收到了不属于它的 Step（{}）",
                step_kind(step)
            )));
        };
        if ctx.files.is_empty() {
            if *optional {
                put(&mut ctx.scope, into, "", "other", 0);
                return Ok(());
            }
            return Err(StepError::invalid("readFile 需要文件作为输入"));
        }
        let files = ctx.files.clone();
        if ctx.file_scopes.len() < files.len() {
            ctx.file_scopes.resize_with(files.len(), HashMap::new);
        }
        // 几个文件一起读（每批最多 PARALLEL_READS 个），按原顺序写回结果。
        let mut results = Vec::with_capacity(files.len());
        for batch in files.chunks(PARALLEL_READS) {
            let mut set = tokio::task::JoinSet::new();
            for (offset, file) in batch.iter().enumerate() {
                let port = Arc::clone(&self.port);
                let file = file.clone();
                let optional = *optional;
                set.spawn(async move { (offset, read_one(port.as_ref(), &file, optional).await) });
            }
            let mut batch_results: Vec<_> = Vec::with_capacity(batch.len());
            while let Some(joined) = set.join_next().await {
                let (offset, result) =
                    joined.map_err(|e| StepError::fatal(format!("读取文件的任务失败：{e}")))?;
                batch_results.push((offset, result?));
            }
            batch_results.sort_by_key(|(offset, _)| *offset);
            results.extend(batch_results.into_iter().map(|(_, r)| r));
        }
        for (index, (title, kind, size)) in results.into_iter().enumerate() {
            put(
                &mut ctx.file_scopes[index],
                into,
                &title,
                kind.as_str(),
                size,
            );
            if index == 0 {
                put(&mut ctx.scope, into, &title, kind.as_str(), size);
            }
        }
        Ok(())
    }
}
