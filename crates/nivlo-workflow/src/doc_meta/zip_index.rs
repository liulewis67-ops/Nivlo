//! 不读整个文件就从 zip 容器里取出一个条目：先读末尾的目录，再只读那一个条目。
//!
//! Office（.docx / .pptx / .xlsx）、OpenDocument、EPUB 都是 zip，标题在一个很小的元数据条目里；
//! 一个塞满图片和视频的 200 MB 演示文稿，读几十 KB 就能拿到标题。这里只做纯解析，IO 由调用方
//! （`readFile` Step 经 `FileInspector`）完成：
//!
//! 1. 读文件末尾 [`TAIL_BYTES`]，[`directory_location`] 找到中央目录的位置；
//! 2. 读中央目录，[`find_entry`] 找到想要的条目；
//! 3. 读条目的本地文件头（[`LOCAL_HEADER_BYTES`]），[`data_offset`] 算出数据从哪里开始；
//! 4. 读压缩数据，[`inflate`] 解压。
//!
//! 不支持 Zip64（4 GB 以上）与加密条目：返回 `None`，调用方退回文件名。

use std::io::Read;

/// 末尾目录记录（22 字节）加上最长 64 KiB 的注释。
pub const TAIL_BYTES: u64 = 22 + 65_535;
/// 本地文件头的固定部分。
pub const LOCAL_HEADER_BYTES: u64 = 30;
/// 中央目录最多读多大（条目很多的文件也够用）。
pub const MAX_DIRECTORY_BYTES: u64 = 4 * 1024 * 1024;
/// 元数据条目解压后最多保留多少字节。
pub const MAX_ENTRY_BYTES: u64 = 256 * 1024;

/// 小端读取。
fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/// 小端读取。
fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// 中央目录在文件里的 `(偏移, 大小)`。`tail` 是文件末尾的字节，从文件偏移 `tail_offset` 开始。
#[must_use]
pub fn directory_location(tail: &[u8], tail_offset: u64) -> Option<(u64, u64)> {
    // 末尾目录记录的签名 `PK\x05\x06`，从后往前找（后面可能跟着注释）。
    let at = tail.windows(4).rposition(|w| w == b"PK\x05\x06")?;
    let size = u32_at(tail, at + 12)?;
    let offset = u32_at(tail, at + 16)?;
    if size == u32::MAX || offset == u32::MAX {
        return None; // Zip64
    }
    // 偏移必须落在末尾记录之前。
    let end = tail_offset + u64::try_from(at).ok()?;
    (u64::from(offset) + u64::from(size) <= end).then_some((u64::from(offset), u64::from(size)))
}

/// 中央目录里的一个条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// 条目名。
    pub name: String,
    /// 压缩方式：0 不压缩，8 Deflate。
    pub method: u16,
    /// 压缩后的大小。
    pub compressed_size: u64,
    /// 本地文件头在文件里的偏移。
    pub local_header_offset: u64,
}

/// 在中央目录里找第一个名字满足 `wanted` 的条目。
#[must_use]
pub fn find_entry(directory: &[u8], wanted: impl Fn(&str) -> bool) -> Option<Entry> {
    let mut at = 0;
    while u32_at(directory, at)? == 0x0201_4b50 {
        let flags = u16_at(directory, at + 8)?;
        let method = u16_at(directory, at + 10)?;
        let compressed = u32_at(directory, at + 20)?;
        let name_len = usize::from(u16_at(directory, at + 28)?);
        let extra_len = usize::from(u16_at(directory, at + 30)?);
        let comment_len = usize::from(u16_at(directory, at + 32)?);
        let local = u32_at(directory, at + 42)?;
        let name = String::from_utf8_lossy(directory.get(at + 46..at + 46 + name_len)?);
        // 加密（flag 第 0 位）与 Zip64 的条目跳过。
        if flags & 1 == 0 && compressed != u32::MAX && local != u32::MAX && wanted(&name) {
            return Some(Entry {
                name: name.into_owned(),
                method,
                compressed_size: u64::from(compressed),
                local_header_offset: u64::from(local),
            });
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    None
}

/// 由本地文件头算出数据的起始偏移。
#[must_use]
pub fn data_offset(entry: &Entry, local_header: &[u8]) -> Option<u64> {
    if u32_at(local_header, 0)? != 0x0403_4b50 {
        return None;
    }
    let name_len = u64::from(u16_at(local_header, 26)?);
    let extra_len = u64::from(u16_at(local_header, 28)?);
    Some(entry.local_header_offset + LOCAL_HEADER_BYTES + name_len + extra_len)
}

/// 解压条目数据（最多 [`MAX_ENTRY_BYTES`]）；不认识的压缩方式返回 `None`。
#[must_use]
pub fn inflate(entry: &Entry, data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    match entry.method {
        0 => out.extend_from_slice(&data[..data.len().min(usize::try_from(MAX_ENTRY_BYTES).ok()?)]),
        8 => {
            // 损坏的数据：保留已经解出来的部分。
            let _ = flate2::read::DeflateDecoder::new(data)
                .take(MAX_ENTRY_BYTES)
                .read_to_end(&mut out);
        }
        _ => return None,
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::io::Write;

    use super::*;

    /// 走一遍完整流程（模拟分段读取）。
    fn extract(file: &[u8], wanted: &str) -> Option<Vec<u8>> {
        let size = file.len() as u64;
        let tail_offset = size.saturating_sub(TAIL_BYTES);
        let tail = &file[usize::try_from(tail_offset).unwrap()..];
        let (offset, len) = directory_location(tail, tail_offset)?;
        let directory = &file[offset as usize..(offset + len) as usize];
        let entry = find_entry(directory, |name| name == wanted)?;
        let header = &file[entry.local_header_offset as usize..];
        let start = data_offset(&entry, header)? as usize;
        inflate(&entry, &file[start..start + entry.compressed_size as usize])
    }

    #[test]
    fn one_entry_is_found_without_reading_the_rest() {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let deflated = zip::write::SimpleFileOptions::default();
            let stored = deflated.compression_method(zip::CompressionMethod::Stored);
            writer.start_file("ppt/media/video.bin", stored).unwrap();
            writer.write_all(&vec![7_u8; 200_000]).unwrap();
            writer.start_file("docProps/core.xml", deflated).unwrap();
            writer
                .write_all("<dc:title>季度汇报</dc:title>".as_bytes())
                .unwrap();
            writer.start_file("mimetype", stored).unwrap();
            writer.write_all(b"application/epub+zip").unwrap();
            writer.set_comment("a comment at the end");
            writer.finish().unwrap();
        }
        assert_eq!(
            extract(&buffer, "docProps/core.xml").unwrap(),
            "<dc:title>季度汇报</dc:title>".as_bytes()
        );
        assert_eq!(
            extract(&buffer, "mimetype").unwrap(),
            b"application/epub+zip"
        );
        assert_eq!(extract(&buffer, "missing.xml"), None);
        assert_eq!(directory_location(b"not a zip", 0), None);
    }
}
