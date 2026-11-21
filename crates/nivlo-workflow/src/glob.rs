//! 通配符匹配（Matcher 的 `glob` 运算符）：`*` 匹配任意多个字符，`?` 匹配一个字符，忽略大小写。
//!
//! 用双指针 + 回溯到最近一个 `*` 的经典做法，最坏 O(n·m)，不会因为 `*a*a*a*b` 之类的模式指数爆炸。

/// `text` 是否匹配通配模式 `pattern`（忽略大小写）。
#[must_use]
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let text: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let (mut p, mut t) = (0_usize, 0_usize);
    // 最近一个 `*` 的位置，以及它当前吞到了 text 的哪里。
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p, t));
                p += 1;
            }
            Some(&c) if c == '?' || c == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match star {
                // 回溯：让最近的 `*` 多吞一个字符。
                Some((star_p, star_t)) => {
                    p = star_p + 1;
                    t = star_t + 1;
                    star = Some((star_p, star_t + 1));
                }
                None => return false,
            },
        }
    }
    // text 用完了，pattern 剩下的只能是 `*`。
    pattern[p..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::glob_match;

    #[test]
    fn wildcards_match_hosts_and_file_names() {
        assert!(glob_match("*.atlassian.net", "acme.atlassian.net"));
        assert!(glob_match("*.atlassian.net", "a.b.atlassian.net"));
        assert!(!glob_match("*.atlassian.net", "atlassian.net"));
        assert!(glob_match("REQ-*.docx", "req-123 终稿.DOCX"));
        assert!(!glob_match("REQ-*.docx", "req-123.pdf"));
        assert!(glob_match("report-?.pdf", "report-7.pdf"));
        assert!(!glob_match("report-?.pdf", "report-77.pdf"));
        assert!(glob_match("*", ""));
        assert!(glob_match("*", "任何东西"));
        assert!(glob_match("", ""));
        assert!(!glob_match("", "x"));
        assert!(glob_match("设计稿*", "设计稿 v2.fig"));
    }

    #[test]
    fn pathological_patterns_stay_fast() {
        let text = "a".repeat(5_000);
        assert!(!glob_match(&format!("{}b", "*a".repeat(40)), &text));
        assert!(glob_match(&"*".repeat(500), &text));
    }
}
