//! Rust 侧（托盘、原生对话框）的文案语言（实施计划 7.5、D-14）。
//!
//! 语言偏好保存在 `settings` 表的 `ui.language`，与前端同一份；这里只提供语言枚举与解析，
//! 具体文案放在使用它的模块（`tray`、`autostart`）里，按语言选择。

use starat_application::settings::{SettingsService, keys};

/// 原生界面支持的语言。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Lang {
    /// 简体中文（默认，与前端一致）。
    #[default]
    ZhCn,
    /// 英文。
    En,
}

impl Lang {
    /// 从设置里的文本还原；不认识的值返回 `None`。
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "zh-CN" => Some(Self::ZhCn),
            "en" => Some(Self::En),
            _ => None,
        }
    }
}

impl Lang {
    /// 从系统区域标记（如 `en-US`、`zh-Hans-CN`）推断：中文用简体中文，其余用英文。
    #[must_use]
    pub fn from_system_tag(tag: &str) -> Self {
        if tag.to_ascii_lowercase().starts_with("zh") {
            Self::ZhCn
        } else {
            Self::En
        }
    }

    /// 系统界面语言；读不到时用默认语言。数据库不可用（读不到语言设置）时用它。
    #[must_use]
    pub fn from_system() -> Self {
        sys_locale::get_locale().map_or_else(Self::default, |tag| Self::from_system_tag(&tag))
    }
}

impl From<Lang> for starat_scheduler::Locale {
    fn from(lang: Lang) -> Self {
        match lang {
            Lang::ZhCn => Self::ZhCn,
            Lang::En => Self::En,
        }
    }
}

/// 读取当前语言；没设置过、值不认识或读取失败时用默认语言。
pub async fn current(settings: &SettingsService) -> Lang {
    match settings.get(keys::UI_LANGUAGE).await {
        Ok(Some(value)) => Lang::parse(&value).unwrap_or_default(),
        Ok(None) => Lang::default(),
        Err(error) => {
            tracing::warn!(event = "language_read_failed", %error, "读取界面语言失败");
            Lang::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Lang;

    #[test]
    fn parses_known_languages_only() {
        assert_eq!(Lang::parse("zh-CN"), Some(Lang::ZhCn));
        assert_eq!(Lang::parse("en"), Some(Lang::En));
        assert_eq!(Lang::parse("fr"), None);
        assert_eq!(Lang::default(), Lang::ZhCn);
        assert_eq!(Lang::from_system_tag("zh-Hans-CN"), Lang::ZhCn);
        assert_eq!(Lang::from_system_tag("en-US"), Lang::En);
    }
}
