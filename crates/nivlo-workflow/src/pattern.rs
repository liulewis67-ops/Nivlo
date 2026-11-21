//! 正则的编译与缓存。
//!
//! Workflow 里的正则来自用户（或导入的文件），所以有硬性限制：模式长度、编译后的自动机大小、嵌套深度。
//! 超限的在**保存时**就被拒绝；运行时遇到仍然不会 panic，只是不匹配。`regex` crate 本身保证线性时间匹配，
//! 不会出现灾难性回溯。编译结果按模式文本缓存，同一个 Workflow 反复匹配不用重复编译。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use regex::{Regex, RegexBuilder};

/// 模式允许的最大字符数。
pub const MAX_PATTERN_CHARS: usize = 200;

/// 编译后自动机的大小上限（字节）。
const SIZE_LIMIT: usize = 256 * 1024;

/// 嵌套深度上限。
const NEST_LIMIT: u32 = 20;

/// 缓存里最多保留多少个编译结果，超过就整体清空（简单且足够）。
const MAX_CACHED: usize = 256;

/// 正则不可用。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PatternError {
    /// 模式太长。
    #[error("正则太长（最多 {MAX_PATTERN_CHARS} 个字符）")]
    TooLong,
    /// 语法错误或超出复杂度限制。
    #[error("正则不合法：{0}")]
    Invalid(String),
}

/// 编译缓存。
#[derive(Debug, Default)]
pub struct RegexCache {
    /// 模式文本 → 编译结果。
    cache: Mutex<HashMap<String, Arc<Regex>>>,
}

impl RegexCache {
    /// 创建空缓存。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 取得编译好的正则（命中缓存则不重新编译）。
    ///
    /// # Errors
    ///
    /// 模式过长、语法错误或超出复杂度限制。
    pub fn get(&self, pattern: &str) -> Result<Arc<Regex>, PatternError> {
        if pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(PatternError::TooLong);
        }
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(found) = cache.get(pattern) {
            return Ok(found.clone());
        }
        let compiled = Arc::new(
            RegexBuilder::new(pattern)
                .size_limit(SIZE_LIMIT)
                .dfa_size_limit(SIZE_LIMIT)
                .nest_limit(NEST_LIMIT)
                .build()
                .map_err(|error| PatternError::Invalid(error.to_string()))?,
        );
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
        cache.insert(pattern.to_owned(), compiled.clone());
        Ok(compiled)
    }

    /// 缓存里现在有多少个编译结果（测试用）。
    #[must_use]
    pub fn len(&self) -> usize {
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// 缓存是否为空。
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn compiled_patterns_are_cached_and_reused() {
        let cache = RegexCache::new();
        let first = cache.get(r"REQ-(\d+)").unwrap();
        let second = cache.get(r"REQ-(\d+)").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(cache.len(), 1);
        assert!(first.is_match("REQ-12"));
    }

    #[test]
    fn invalid_long_and_too_complex_patterns_are_rejected() {
        let cache = RegexCache::new();
        assert!(matches!(cache.get("("), Err(PatternError::Invalid(_))));
        assert!(matches!(
            cache.get(&"a".repeat(MAX_PATTERN_CHARS + 1)),
            Err(PatternError::TooLong)
        ));
        // 展开后超过自动机大小上限。
        assert!(matches!(
            cache.get(r"(\w{100}){100}"),
            Err(PatternError::Invalid(_))
        ));
        assert!(cache.is_empty(), "失败的编译不进缓存");
    }

    #[test]
    fn matching_is_linear_even_for_classic_backtracking_bombs() {
        let cache = RegexCache::new();
        let re = cache.get(r"^(a+)+$").unwrap();
        let input = format!("{}!", "a".repeat(10_000));
        assert!(!re.is_match(&input));
    }
}
