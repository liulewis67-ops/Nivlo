//! 找 PDF 标题需要的最小结构解析：trailer 的 `/Info` 引用、按编号找对象、解压对象流与 XMP 元数据流。
//!
//! 不是 PDF 解析器：不建交叉引用表，只按关键字扫描字节。PDF 1.5 起大多数生成器把字典放进
//! 压缩的对象流（`/Type /ObjStm`），元数据流也常被压缩——不解压就找不到标题。
//! 解压有上限（流的个数、单个与总的解压后大小），恶意文件不会撑爆内存。
//! 只解压对象流与元数据流；页面内容、图片等其他流跳过。

use std::io::Read;

use flate2::read::ZlibDecoder;

use super::find;

/// 最多解压多少个流。
const MAX_STREAMS: usize = 64;
/// 单个流解压后最多保留多少字节。
const MAX_INFLATED: u64 = 8 * 1024 * 1024;
/// 全部流解压后的总上限。
const MAX_TOTAL: usize = 32 * 1024 * 1024;
/// 从 `stream` 关键字往回最多找多远的字典。
const DICT_WINDOW: usize = 4096;

/// 一个解压后的流。
pub(super) struct Stream {
    /// 解压后的内容。
    pub data: Vec<u8>,
    /// 是不是对象流（`/Type /ObjStm`）。
    pub is_object_stream: bool,
    /// 对象流：第一个对象在 `data` 里的偏移（`/First`）。
    first: usize,
    /// 对象流：里面有几个对象（`/N`）。
    count: usize,
}

impl Stream {
    /// 对象流里编号为 `number` 的对象的内容。
    pub fn object(&self, number: u32) -> Option<Vec<u8>> {
        if !self.is_object_stream {
            return None;
        }
        let header = std::str::from_utf8(self.data.get(..self.first)?).ok()?;
        let numbers: Vec<usize> = header
            .split_ascii_whitespace()
            .filter_map(|token| token.parse().ok())
            .collect();
        let pairs: Vec<(usize, usize)> = numbers
            .chunks_exact(2)
            .take(if self.count == 0 {
                usize::MAX
            } else {
                self.count
            })
            .map(|pair| (pair[0], pair[1]))
            .collect();
        let number = usize::try_from(number).ok()?;
        let (_, offset) = pairs.iter().find(|(n, _)| *n == number)?;
        let start = self.first.checked_add(*offset)?;
        // 下一个对象的开头就是这个对象的结尾（偏移不保证有序，取比它大的最小值）。
        let end = pairs
            .iter()
            .map(|(_, o)| self.first + o)
            .filter(|o| *o > start)
            .min()
            .unwrap_or(self.data.len())
            .min(self.data.len());
        self.data.get(start..end).map(<[u8]>::to_vec)
    }
}

/// 从后往前找子串。
fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// 子串是否出现。
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle, 0).is_some()
}

/// 跳过空白之后读一个非负整数，返回数值与结束位置。
fn number_at(bytes: &[u8], mut at: usize) -> Option<(u32, usize)> {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    let start = at;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    let digits = std::str::from_utf8(bytes.get(start..at)?).ok()?;
    Some((digits.parse().ok()?, at))
}

/// 字典里某个键后面的整数（`/First 123`）。
fn number_after(dict: &[u8], key: &[u8]) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = find(dict, key, from) {
        from = at + key.len();
        // `/N` 不能是 `/Names` 的开头。
        if dict.get(from).is_some_and(u8::is_ascii_alphanumeric) {
            continue;
        }
        if let Some((n, _)) = number_at(dict, from) {
            return usize::try_from(n).ok();
        }
    }
    None
}

/// trailer（或交叉引用流字典）里的 `/Info N G R`；增量更新时最后一个才是当前的。
pub(super) fn info_reference(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut found = None;
    let mut from = 0;
    while let Some(at) = find(bytes, b"/Info", from) {
        from = at + b"/Info".len();
        let Some((number, after)) = number_at(bytes, from) else {
            continue;
        };
        let Some((generation, after)) = number_at(bytes, after) else {
            continue;
        };
        let mut at = after;
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        if bytes.get(at) == Some(&b'R') {
            found = Some((number, generation));
        }
    }
    found
}

/// 未压缩的 `N G obj … endobj` 的内容；同一个对象出现多次（增量更新）时取最后一个。
pub(super) fn object_body(bytes: &[u8], number: u32, generation: u32) -> Option<&[u8]> {
    let header = format!("{number} {generation} obj");
    let header = header.as_bytes();
    let mut found = None;
    let mut from = 0;
    while let Some(at) = find(bytes, header, from) {
        from = at + header.len();
        // `12 0 obj` 不能是 `112 0 obj` 的后半截。
        if at > 0 && bytes[at - 1].is_ascii_digit() {
            continue;
        }
        let end = find(bytes, b"endobj", from).unwrap_or(bytes.len());
        found = Some(&bytes[from..end]);
    }
    found
}

/// 解压文件里的对象流与元数据流（只认 `FlateDecode`）。
pub(super) fn inflated_streams(bytes: &[u8]) -> Vec<Stream> {
    let mut streams = Vec::new();
    let mut total = 0_usize;
    let mut from = 0;
    while streams.len() < MAX_STREAMS && total < MAX_TOTAL {
        let Some(at) = find(bytes, b"stream", from) else {
            break;
        };
        from = at + b"stream".len();
        if at >= 3 && &bytes[at - 3..at] == b"end" {
            continue;
        }
        // 关键字后面是换行（`\r\n` 或 `\n`），之后才是数据。
        let mut start = from;
        if bytes.get(start) == Some(&b'\r') {
            start += 1;
        }
        if bytes.get(start) == Some(&b'\n') {
            start += 1;
        } else if start == from {
            continue;
        }
        let window = &bytes[at.saturating_sub(DICT_WINDOW)..at];
        let dict = rfind(window, b"obj").map_or(window, |o| &window[o..]);
        let object_stream = contains(dict, b"/ObjStm");
        let metadata = contains(dict, b"/Metadata") || contains(dict, b"/XML");
        if !contains(dict, b"/FlateDecode") || !(object_stream || metadata) {
            continue;
        }
        let end = find(bytes, b"endstream", start).unwrap_or(bytes.len());
        from = end;
        let mut data = Vec::new();
        // 数据损坏时保留已经解出来的部分。
        let _ = ZlibDecoder::new(&bytes[start..end])
            .take(MAX_INFLATED)
            .read_to_end(&mut data);
        if data.is_empty() {
            continue;
        }
        total += data.len();
        streams.push(Stream {
            is_object_stream: object_stream,
            first: number_after(dict, b"/First").unwrap_or(0),
            count: number_after(dict, b"/N").unwrap_or(0),
            data,
        });
    }
    streams
}
