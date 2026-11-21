//! 前台窗口的记忆与还原（`ForegroundPort`）。
//!
//! 悬浮窗平时不可聚焦，不会抢走用户当前应用的焦点。但 Quick Create 要打字，必须临时获得
//! 键盘焦点；结束后应当把焦点还给用户之前所在的应用，否则焦点会残留在悬浮窗里，
//! 用户继续打字时没有任何地方接收（产品文档 §6.2、实施计划 1.5 / 2.6）。
//!
//! 记忆 / 还原的**决策逻辑**（别记住自己、窗口已关闭就放弃、只还原一次）与具体的操作系统调用分离：
//! 逻辑在 [`ForegroundTracker`] 中，用一个很小的 [`ForegroundOs`] 抽象访问系统，因此可以
//! 脱离 Win32 做单元测试。

use std::sync::{Mutex, PoisonError};

use crate::error::PlatformError;

/// 记住并还原用户当前的前台窗口。
pub trait ForegroundPort: Send + Sync {
    /// 记住当前的前台窗口（悬浮窗即将抢占焦点之前调用）。
    ///
    /// 当前前台窗口就是悬浮窗自己时不覆盖之前记住的窗口。
    ///
    /// # Errors
    ///
    /// 平台不支持时返回 [`PlatformError::Unsupported`]。
    fn remember(&self) -> Result<(), PlatformError>;

    /// 把焦点还给 [`ForegroundPort::remember`] 记住的窗口；没有记住的窗口或该窗口已不存在时是空操作。
    /// 每次记住只会还原一次。
    ///
    /// # Errors
    ///
    /// 系统拒绝切换前台窗口时返回 [`PlatformError::Failed`]。
    fn restore(&self) -> Result<(), PlatformError>;
}

/// 前台窗口相关的最小系统接口；窗口句柄用不透明的 `isize` 表示。
pub trait ForegroundOs: Send + Sync {
    /// 当前前台窗口的句柄；没有前台窗口时为 `0`。
    fn foreground(&self) -> isize;
    /// 最近一次成为前台的、**属于其他进程**的窗口句柄；未知时为 `0`。
    ///
    /// 用户点击悬浮窗时，WebView 可能在 Rust 来得及记录之前就把悬浮窗自己激活为前台，
    /// 此时 [`ForegroundOs::foreground`] 已经是悬浮窗自己，只能依靠系统事件持续跟踪来知道
    /// 用户之前在哪个应用里。
    fn last_other_foreground(&self) -> isize;
    /// 句柄是否仍然指向一个存在的窗口。
    fn is_window(&self, handle: isize) -> bool;
    /// 把窗口设为前台；系统拒绝时返回 `false`。
    fn set_foreground(&self, handle: isize) -> bool;
}

/// 基于 [`ForegroundOs`] 的记忆 / 还原逻辑。
pub struct ForegroundTracker<O: ForegroundOs> {
    /// 系统接口。
    os: O,
    /// 悬浮窗自己的窗口句柄；它不能被记为"用户之前的窗口"。
    own: isize,
    /// 记住的、之后要还原的窗口。
    previous: Mutex<Option<isize>>,
}

impl<O: ForegroundOs> ForegroundTracker<O> {
    /// 创建跟踪器；`own` 是悬浮窗自己的窗口句柄。
    pub fn new(os: O, own: isize) -> Self {
        Self {
            os,
            own,
            previous: Mutex::new(None),
        }
    }
}

impl<O: ForegroundOs> ForegroundPort for ForegroundTracker<O> {
    /// 记住用户当前所在的窗口。
    ///
    /// 优先用当前前台窗口；如果前台已经是悬浮窗自己（点击时被抢先激活了），
    /// 就退回到系统事件跟踪到的"最近一个其他进程的前台窗口"。两者都没有可用的窗口时保持原记录不变。
    fn remember(&self) -> Result<(), PlatformError> {
        let current = self.os.foreground();
        let current = if current != 0 && current != self.own {
            current
        } else {
            self.os.last_other_foreground()
        };
        let remembered = current != 0 && current != self.own;
        tracing::debug!(
            event = "foreground_remember",
            current,
            own = self.own,
            remembered,
            "记住前台窗口"
        );
        if remembered {
            *self.previous.lock().unwrap_or_else(PoisonError::into_inner) = Some(current);
        }
        Ok(())
    }

    /// 还原记住的窗口。
    fn restore(&self) -> Result<(), PlatformError> {
        let previous = self
            .previous
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(handle) = previous else {
            tracing::debug!(
                event = "foreground_restore_skipped",
                reason = "nothing remembered",
                "没有可还原的前台窗口"
            );
            return Ok(());
        };
        // 用户在输入期间可能已经关掉了那个应用；窗口不存在就不必（也不能）还原。
        if !self.os.is_window(handle) {
            return Ok(());
        }
        let accepted = self.os.set_foreground(handle);
        tracing::debug!(
            event = "foreground_restore",
            handle,
            accepted,
            now = self.os.foreground(),
            "还原前台窗口"
        );
        if accepted {
            Ok(())
        } else {
            Err(PlatformError::Failed(
                "系统拒绝把焦点还给之前的窗口".to_owned(),
            ))
        }
    }
}

/// 不支持前台窗口还原的平台使用的空实现：记住 / 还原都是空操作。
///
/// 这样悬浮窗在这些平台上仍可使用，只是结束 Quick Create 后需要用户自己点回原来的应用
/// （平台能力不足时降级而不是失败，架构文档 §53）。
#[derive(Debug, Default, Clone, Copy)]
pub struct UnsupportedForeground;

impl ForegroundPort for UnsupportedForeground {
    /// 空操作。
    fn remember(&self) -> Result<(), PlatformError> {
        Ok(())
    }

    /// 空操作。
    fn restore(&self) -> Result<(), PlatformError> {
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// 假系统：可设置前台窗口、窗口存活集合，并记录 `set_foreground` 调用。
    struct FakeOs {
        state: Mutex<FakeOsState>,
    }

    /// [`FakeOs`] 的内部状态。
    struct FakeOsState {
        foreground: isize,
        last_other: isize,
        alive: Vec<isize>,
        set_calls: Vec<isize>,
        allow_set: bool,
    }

    impl FakeOs {
        /// 创建假系统。
        fn new(foreground: isize, alive: &[isize]) -> Self {
            Self {
                state: Mutex::new(FakeOsState {
                    foreground,
                    last_other: foreground,
                    alive: alive.to_vec(),
                    set_calls: Vec::new(),
                    allow_set: true,
                }),
            }
        }
    }

    impl ForegroundOs for &FakeOs {
        fn foreground(&self) -> isize {
            self.state.lock().unwrap().foreground
        }
        fn last_other_foreground(&self) -> isize {
            self.state.lock().unwrap().last_other
        }
        fn is_window(&self, handle: isize) -> bool {
            self.state.lock().unwrap().alive.contains(&handle)
        }
        fn set_foreground(&self, handle: isize) -> bool {
            let mut state = self.state.lock().unwrap();
            state.set_calls.push(handle);
            state.allow_set
        }
    }

    const OWN: isize = 1;
    const NOTEPAD: isize = 100;

    #[test]
    fn restores_the_remembered_window_exactly_once() {
        let os = FakeOs::new(NOTEPAD, &[NOTEPAD, OWN]);
        let tracker = ForegroundTracker::new(&os, OWN);

        tracker.remember().unwrap();
        tracker.restore().unwrap();
        tracker.restore().unwrap();

        assert_eq!(os.state.lock().unwrap().set_calls, [NOTEPAD]);
    }

    #[test]
    fn the_overlay_never_remembers_itself() {
        let os = FakeOs::new(NOTEPAD, &[NOTEPAD, OWN]);
        let tracker = ForegroundTracker::new(&os, OWN);
        tracker.remember().unwrap();

        // 悬浮窗已经获得焦点后再次 remember（例如重复进入输入状态）：不能把自己记成"之前的窗口"。
        os.state.lock().unwrap().foreground = OWN;
        tracker.remember().unwrap();
        tracker.restore().unwrap();

        assert_eq!(os.state.lock().unwrap().set_calls, [NOTEPAD]);
    }

    #[test]
    fn falls_back_to_the_last_other_foreground_when_the_overlay_was_activated_first() {
        // 点击悬浮窗时 WebView 抢先激活了它：此刻前台已是自己，但系统事件记录着用户之前在 Notepad。
        let os = FakeOs::new(NOTEPAD, &[NOTEPAD, OWN]);
        {
            let mut state = os.state.lock().unwrap();
            state.foreground = OWN;
            state.last_other = NOTEPAD;
        }
        let tracker = ForegroundTracker::new(&os, OWN);

        tracker.remember().unwrap();
        tracker.restore().unwrap();

        assert_eq!(os.state.lock().unwrap().set_calls, [NOTEPAD]);
    }

    #[test]
    fn the_current_foreground_wins_over_the_tracked_one() {
        let os = FakeOs::new(NOTEPAD, &[NOTEPAD, 200, OWN]);
        os.state.lock().unwrap().last_other = 200;
        let tracker = ForegroundTracker::new(&os, OWN);

        tracker.remember().unwrap();
        tracker.restore().unwrap();

        assert_eq!(os.state.lock().unwrap().set_calls, [NOTEPAD]);
    }

    #[test]
    fn nothing_is_restored_when_nothing_was_remembered() {
        let os = FakeOs::new(0, &[]);
        let tracker = ForegroundTracker::new(&os, OWN);
        tracker.remember().unwrap();
        tracker.restore().unwrap();
        assert!(os.state.lock().unwrap().set_calls.is_empty());
    }

    #[test]
    fn a_window_that_was_closed_in_the_meantime_is_skipped() {
        let os = FakeOs::new(NOTEPAD, &[NOTEPAD, OWN]);
        let tracker = ForegroundTracker::new(&os, OWN);
        tracker.remember().unwrap();
        os.state.lock().unwrap().alive.retain(|h| *h != NOTEPAD);

        tracker.restore().unwrap();

        assert!(os.state.lock().unwrap().set_calls.is_empty());
    }

    #[test]
    fn a_refusal_from_the_system_is_reported() {
        let os = FakeOs::new(NOTEPAD, &[NOTEPAD]);
        os.state.lock().unwrap().allow_set = false;
        let tracker = ForegroundTracker::new(&os, OWN);
        tracker.remember().unwrap();
        assert!(matches!(tracker.restore(), Err(PlatformError::Failed(_))));
    }

    #[test]
    fn the_unsupported_implementation_is_a_harmless_no_op() {
        assert!(UnsupportedForeground.remember().is_ok());
        assert!(UnsupportedForeground.restore().is_ok());
    }
}
