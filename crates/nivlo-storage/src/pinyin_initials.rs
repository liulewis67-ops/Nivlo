//! 拼音首字母（交互优化计划 P2「搜索质量」第 3 项）：让 `bzzb` 找到「本周周报」。
//!
//! 只取标题里**汉字**的首字母，英文、数字、标点都跳过——英文标题已经能被全文搜索直接命中，
//! 再把它们的字母混进来只会让两三个字母的查询误中一堆英文标题。多音字取最常用的读音。

use pinyin::ToPinyin;

/// 标题的拼音首字母（小写）；标题里没有汉字时为空字符串。
///
/// 存为空字符串而不是 NULL，回填时就能用 `IS NULL` 区分「还没算过」与「没有汉字」。
pub(crate) fn title_initials(title: &str) -> String {
    title
        .chars()
        .filter_map(|c| c.to_pinyin())
        .filter_map(|p| p.first_letter().chars().next())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// 用户输入是否像拼音首字母查询：去掉首尾空白后是 2 个以上的纯字母、中间没有空格。
/// 是的话返回小写形式。
///
/// 一个字母太宽泛（几乎每条中文标题都会命中），不参与。
pub(crate) fn initials_query(text: &str) -> Option<String> {
    let text = text.trim();
    (text.chars().count() >= 2 && text.chars().all(|c| c.is_ascii_alphabetic()))
        .then(|| text.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::{initials_query, title_initials};

    #[test]
    fn only_chinese_characters_contribute_initials() {
        assert_eq!(title_initials("整理本周周报"), "zlbzzb");
        assert_eq!(title_initials("修复 login 超时 #42"), "xfcs");
        assert_eq!(title_initials("Fix login timeout"), "");
        assert_eq!(title_initials(""), "");
    }

    #[test]
    fn only_letter_runs_of_two_or_more_are_initials_queries() {
        assert_eq!(initials_query(" BZZB "), Some("bzzb".to_owned()));
        assert_eq!(initials_query("zb"), Some("zb".to_owned()));
        assert_eq!(initials_query("z"), None);
        assert_eq!(initials_query("zb zb"), None);
        assert_eq!(initials_query("周报"), None);
        assert_eq!(initials_query("v2"), None);
    }
}
