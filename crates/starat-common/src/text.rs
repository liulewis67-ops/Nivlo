//! 文本文件的编码识别：把一段字节解码成文字，认不出就说不是文本。
//!
//! Windows 上（尤其是中文系统）大量文本文件不是 UTF-8：记事本旧版存的是 GBK，
//! 一些工具导出的是带 BOM 的 UTF-16。顺序：
//!
//! 1. BOM：UTF-8 / UTF-16LE / UTF-16BE；
//! 2. 合法的 UTF-8（没有 NUL）；
//! 3. GB18030（GBK / GB2312 的超集）：必须能**无替换**地完整解码，并且没有 NUL 与异常控制字符——
//!    二进制文件几乎不可能同时满足，所以不会把图片、压缩包误认成中文文本。
//!
//! 字节可能是从文件头截出来的样本，末尾被切断的半个字符不算错误（最多去掉 3 个字节再试）。

use std::borrow::Cow;

use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE};

/// 文本里允许出现的控制字符之外，其余 C0 控制字符出现就说明不是文本（GB18030 判定时用）。
fn has_unexpected_controls(text: &str) -> bool {
    text.chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\u{0c}' | '\u{1b}'))
}

/// 用给定编码严格解码；末尾最多 `slack` 个字节可以是被截断的半个字符。
fn strict<'a>(encoding: &'static Encoding, bytes: &'a [u8], slack: usize) -> Option<Cow<'a, str>> {
    (0..=slack.min(bytes.len())).find_map(|cut| {
        encoding.decode_without_bom_handling_and_without_replacement(&bytes[..bytes.len() - cut])
    })
}

/// UTF-8：合法（允许末尾被截断）且没有 NUL。
fn utf8(bytes: &[u8]) -> Option<&str> {
    if bytes.contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    }
}

/// 把文本文件的字节解码成文字；看起来不是文本时返回 `None`。空字节也返回 `None`。
#[must_use]
pub fn decode_text_file(bytes: &[u8]) -> Option<Cow<'_, str>> {
    if bytes.is_empty() {
        return None;
    }
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return Some(String::from_utf8_lossy(rest));
    }
    for (bom, encoding) in [(b"\xFF\xFE", UTF_16LE), (b"\xFE\xFF", UTF_16BE)] {
        if let Some(rest) = bytes.strip_prefix(bom) {
            // UTF-16 一个码元两个字节，代理对四个：最多切掉 3 个字节。
            return strict(encoding, rest, 3).filter(|text| !text.contains('\0'));
        }
    }
    if let Some(text) = utf8(bytes) {
        return Some(Cow::Borrowed(text));
    }
    if bytes.contains(&0) {
        return None;
    }
    // GB18030 最长 4 个字节一个字符。
    strict(GB18030, bytes, 3).filter(|text| !has_unexpected_controls(text))
}

/// 字节看起来像不像文本（编码规则同 [`decode_text_file`]）。
#[must_use]
pub fn is_probably_text(bytes: &[u8]) -> bool {
    decode_text_file(bytes).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「你好，世界」的 GBK 字节。
    const GBK: &[u8] = &[0xC4, 0xE3, 0xBA, 0xC3, 0xA3, 0xAC, 0xCA, 0xC0, 0xBD, 0xE7];

    #[test]
    fn utf8_with_and_without_a_bom() {
        assert_eq!(
            decode_text_file("# 标题".as_bytes()).as_deref(),
            Some("# 标题")
        );
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice("标题".as_bytes());
        assert_eq!(decode_text_file(&bom).as_deref(), Some("标题"));
    }

    #[test]
    fn utf16_files_with_a_bom_are_text() {
        let mut le = b"\xFF\xFE".to_vec();
        le.extend("# 会议".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_text_file(&le).as_deref(), Some("# 会议"));
        let mut be = b"\xFE\xFF".to_vec();
        be.extend("hi".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(decode_text_file(&be).as_deref(), Some("hi"));
    }

    #[test]
    fn gbk_files_are_decoded() {
        assert_eq!(decode_text_file(GBK).as_deref(), Some("你好，世界"));
        // 样本在一个双字节字符中间被截断。
        assert_eq!(
            decode_text_file(&GBK[..GBK.len() - 1]).as_deref(),
            Some("你好，世")
        );
    }

    #[test]
    fn a_utf8_character_cut_at_the_end_still_counts() {
        let bytes = "中文".as_bytes();
        assert_eq!(decode_text_file(&bytes[..4]).as_deref(), Some("中"));
    }

    #[test]
    fn binary_is_not_text() {
        assert!(!is_probably_text(&[]));
        assert!(!is_probably_text(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"));
        assert!(!is_probably_text(&[0x01, 0x02, 0x03, 0xC4, 0xE3]));
        assert!(!is_probably_text(&[0xFF, 0xD8, 0xFF, 0xE0]));
    }
}
