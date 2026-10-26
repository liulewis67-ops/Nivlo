//! 全局快捷键（`ShortcutPort`，实施计划 2.6）。
//!
//! [`Accelerator`] 是平台无关的快捷键描述：一组修饰键加一个主键，可以和 `Ctrl+Shift+Space`
//! 这样的文本互相转换（设置里就存这个文本）。解析与校验是纯逻辑，在这里测试；
//! 真正向操作系统注册由具体平台的 Adapter 完成。

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use crate::error::PlatformError;

/// 快捷键的主键。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    /// 字母 `A`–`Z`（大写存储）。
    Letter(char),
    /// 数字 `0`–`9`。
    Digit(u8),
    /// 功能键 `F1`–`F24`。
    Function(u8),
    /// 空格。
    Space,
    /// 回车。
    Enter,
    /// Tab。
    Tab,
    /// 上箭头。
    Up,
    /// 下箭头。
    Down,
    /// 左箭头。
    Left,
    /// 右箭头。
    Right,
}

/// 快捷键解析失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AcceleratorError {
    /// 文本是空的。
    #[error("快捷键不能为空")]
    Empty,
    /// 没有修饰键：单独的字母 / 空格会吞掉用户正常的输入，全局快捷键必须至少带一个修饰键。
    #[error("全局快捷键至少需要一个修饰键（Ctrl / Alt / Shift / Win）")]
    NoModifier,
    /// 没有主键（只有修饰键）。
    #[error("缺少主键")]
    NoKey,
    /// 有多个主键。
    #[error("只能有一个主键")]
    MultipleKeys,
    /// 不认识的键名。
    #[error("不认识的按键：{0}")]
    UnknownKey(String),
}

/// 一个全局快捷键：修饰键 + 主键。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Accelerator {
    /// Ctrl。
    pub ctrl: bool,
    /// Alt。
    pub alt: bool,
    /// Shift。
    pub shift: bool,
    /// Windows 键 / Command 键。
    pub meta: bool,
    /// 主键。
    pub key: Key,
}

impl Accelerator {
    /// 默认的 Quick Create 快捷键：`Ctrl+Shift+Space`（产品文档 §6.2）。
    pub const QUICK_CREATE_DEFAULT: Self = Self {
        ctrl: true,
        alt: false,
        shift: true,
        meta: false,
        key: Key::Space,
    };

    /// 默认的全局搜索快捷键：`Ctrl+Alt+Space`（和 Quick Create 同一组按键，好记）。
    pub const SEARCH_DEFAULT: Self = Self {
        ctrl: true,
        alt: true,
        shift: false,
        meta: false,
        key: Key::Space,
    };
}

impl FromStr for Accelerator {
    type Err = AcceleratorError;

    /// 解析 `Ctrl+Shift+Space` 形式的文本：大小写不敏感，`+` 两侧允许空白，修饰键顺序不限；
    /// 接受 `Control` / `Cmd` / `Command` / `Win` / `Super` / `Option` 等常见别名。
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.trim().is_empty() {
            return Err(AcceleratorError::Empty);
        }
        let mut accelerator = Self {
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
            key: Key::Space,
        };
        let mut key: Option<Key> = None;
        for part in text.split('+').map(str::trim) {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => accelerator.ctrl = true,
                "alt" | "option" => accelerator.alt = true,
                "shift" => accelerator.shift = true,
                "win" | "super" | "meta" | "cmd" | "command" => accelerator.meta = true,
                _ => {
                    if key.replace(parse_key(part)?).is_some() {
                        return Err(AcceleratorError::MultipleKeys);
                    }
                }
            }
        }
        accelerator.key = key.ok_or(AcceleratorError::NoKey)?;
        if !(accelerator.ctrl || accelerator.alt || accelerator.shift || accelerator.meta) {
            return Err(AcceleratorError::NoModifier);
        }
        Ok(accelerator)
    }
}

/// 解析主键名。
fn parse_key(name: &str) -> Result<Key, AcceleratorError> {
    let lower = name.to_ascii_lowercase();
    let simple = match lower.as_str() {
        "space" | "spacebar" => Some(Key::Space),
        "enter" | "return" => Some(Key::Enter),
        "tab" => Some(Key::Tab),
        "up" | "arrowup" => Some(Key::Up),
        "down" | "arrowdown" => Some(Key::Down),
        "left" | "arrowleft" => Some(Key::Left),
        "right" | "arrowright" => Some(Key::Right),
        _ => None,
    };
    if let Some(key) = simple {
        return Ok(key);
    }
    let mut chars = lower.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_lowercase() {
            return Ok(Key::Letter(c.to_ascii_uppercase()));
        }
        if let Some(digit) = c.to_digit(10) {
            return Ok(Key::Digit(u8::try_from(digit).unwrap_or(0)));
        }
    }
    if let Some(number) = lower
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        return Ok(Key::Function(number));
    }
    Err(AcceleratorError::UnknownKey(name.to_owned()))
}

impl fmt::Display for Accelerator {
    /// 规范文本：`Ctrl+Alt+Shift+Win+主键`，设置里存的就是它。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (on, name) in [
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.meta, "Win"),
        ] {
            if on {
                write!(f, "{name}+")?;
            }
        }
        match self.key {
            Key::Letter(c) => write!(f, "{c}"),
            Key::Digit(d) => write!(f, "{d}"),
            Key::Function(n) => write!(f, "F{n}"),
            Key::Space => f.write_str("Space"),
            Key::Enter => f.write_str("Enter"),
            Key::Tab => f.write_str("Tab"),
            Key::Up => f.write_str("Up"),
            Key::Down => f.write_str("Down"),
            Key::Left => f.write_str("Left"),
            Key::Right => f.write_str("Right"),
        }
    }
}

/// 快捷键被按下时的回调。它在平台的消息线程上被调用，必须很快返回、不能阻塞。
pub type ShortcutCallback = Arc<dyn Fn() + Send + Sync>;

/// 注册 / 取消全局快捷键。
pub trait ShortcutPort: Send + Sync {
    /// 注册（替换）全局快捷键；此前注册的会先被取消。
    ///
    /// 注册失败时**保持原来的注册不变**，便于在用户输入了冲突的新快捷键时继续使用旧的。
    ///
    /// # Errors
    ///
    /// * [`PlatformError::Conflict`] - 已被其他程序占用。
    /// * [`PlatformError::Unsupported`] - 当前平台不支持。
    /// * [`PlatformError::Failed`] - 其他系统错误。
    fn register(
        &self,
        accelerator: Accelerator,
        on_pressed: ShortcutCallback,
    ) -> Result<(), PlatformError>;

    /// 取消当前注册的快捷键；没有注册时是空操作。
    fn unregister(&self);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_default_and_is_case_and_space_insensitive() {
        for text in [
            "Ctrl+Shift+Space",
            "ctrl + shift + space",
            "SHIFT+CTRL+SPACE",
        ] {
            assert_eq!(
                text.parse::<Accelerator>().unwrap(),
                Accelerator::QUICK_CREATE_DEFAULT,
                "{text}"
            );
        }
    }

    #[test]
    fn display_is_canonical_and_round_trips() {
        let a: Accelerator = "alt+ctrl+q".parse().unwrap();
        assert_eq!(a.to_string(), "Ctrl+Alt+Q");
        assert_eq!(a.to_string().parse::<Accelerator>().unwrap(), a);
        assert_eq!(
            Accelerator::QUICK_CREATE_DEFAULT.to_string(),
            "Ctrl+Shift+Space"
        );
    }

    #[test]
    fn accepts_aliases_function_keys_digits_and_arrows() {
        assert!("Cmd+Option+Up".parse::<Accelerator>().unwrap().meta);
        assert_eq!(
            "Ctrl+F12".parse::<Accelerator>().unwrap().key,
            Key::Function(12)
        );
        assert_eq!("Ctrl+5".parse::<Accelerator>().unwrap().key, Key::Digit(5));
        assert_eq!("Win+Left".parse::<Accelerator>().unwrap().key, Key::Left);
    }

    #[test]
    fn rejects_unusable_shortcuts_with_a_specific_reason() {
        let err = |text: &str| text.parse::<Accelerator>().unwrap_err();
        assert_eq!(err(""), AcceleratorError::Empty);
        assert_eq!(err("   "), AcceleratorError::Empty);
        // 单独的键会吞掉用户的正常输入。
        assert_eq!(err("Space"), AcceleratorError::NoModifier);
        assert_eq!(err("Q"), AcceleratorError::NoModifier);
        assert_eq!(err("Ctrl+Shift"), AcceleratorError::NoKey);
        assert_eq!(err("Ctrl+A+B"), AcceleratorError::MultipleKeys);
        assert_eq!(
            err("Ctrl+Banana"),
            AcceleratorError::UnknownKey("Banana".to_owned())
        );
        assert_eq!(
            err("Ctrl+F25"),
            AcceleratorError::UnknownKey("F25".to_owned())
        );
        assert_eq!(err("Ctrl++"), AcceleratorError::UnknownKey(String::new()));
    }
}
