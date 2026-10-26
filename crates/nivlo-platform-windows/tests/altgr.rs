//! AltGr 检测（真实的 Windows 键盘布局）。
//!
//! 测试会临时加载德语与美式布局（`KLF_NOTELLSHELL`，不通知任务栏），只在加载前本来没有时卸载。

#![cfg(windows)]
#![allow(
    unsafe_code,
    clippy::unwrap_used,
    reason = "测试中直接调用 Win32 加载 / 卸载布局"
)]

use nivlo_platform::shortcut::Accelerator;
use nivlo_platform_windows::shortcut::types_character_in;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayoutList, HKL, KLF_NOTELLSHELL, LoadKeyboardLayoutW, UnloadKeyboardLayout,
};
use windows::core::w;

/// 加载布局，执行 `f`，如果是本测试加载的就卸载。
fn with_layout(id: windows::core::PCWSTR, f: impl FnOnce(HKL)) {
    // SAFETY: GetKeyboardLayoutList 先问数量再取列表，缓冲区长度与数量一致。
    let before: Vec<HKL> = unsafe {
        let n = GetKeyboardLayoutList(None);
        let mut list = vec![HKL::default(); usize::try_from(n).unwrap()];
        GetKeyboardLayoutList(Some(&mut list));
        list
    };
    // SAFETY: id 是合法的布局 ID 字符串常量。
    let layout = unsafe { LoadKeyboardLayoutW(id, KLF_NOTELLSHELL) }.unwrap();
    f(layout);
    if !before.contains(&layout) {
        // SAFETY: 只卸载本测试加载的布局。
        let _ = unsafe { UnloadKeyboardLayout(layout) };
    }
}

fn parse(text: &str) -> Accelerator {
    text.parse().unwrap()
}

#[test]
fn german_altgr_combinations_type_characters() {
    with_layout(w!("00000407"), |german| {
        assert!(
            types_character_in(parse("Ctrl+Alt+Q"), german),
            "AltGr+Q = @"
        );
        assert!(
            types_character_in(parse("Ctrl+Alt+E"), german),
            "AltGr+E = €"
        );
        assert!(!types_character_in(parse("Ctrl+Shift+Space"), german));
        assert!(
            !types_character_in(parse("Ctrl+Alt+Space"), german),
            "默认的全局搜索快捷键"
        );
    });
}

#[test]
fn us_layout_has_no_altgr_characters() {
    with_layout(w!("00000409"), |us| {
        for text in ["Ctrl+Alt+Space", "Ctrl+Alt+Q", "Ctrl+Alt+E", "Ctrl+Alt+F"] {
            assert!(!types_character_in(parse(text), us), "{text}");
        }
    });
}

#[test]
fn default_search_shortcut_is_safe_on_common_altgr_layouts_except_canadian_multilingual() {
    // 德、法、西、意、葡、瑞士德语、波兰（程序员）、捷克、匈牙利、北欧、土耳其、加拿大多语言。
    let layouts = [
        w!("00000407"),
        w!("0000040C"),
        w!("0000040A"),
        w!("00000410"),
        w!("00000816"),
        w!("00000807"),
        w!("00000415"),
        w!("00000405"),
        w!("0000040E"),
        w!("0000041D"),
        w!("00000414"),
        w!("0000041F"),
        w!("00011009"),
    ];
    let mut typing = Vec::new();
    for id in layouts {
        with_layout(id, |layout| {
            if types_character_in(Accelerator::SEARCH_DEFAULT, layout) {
                // SAFETY: PCWSTR 来自 w! 常量。
                typing.push(unsafe { id.to_string() }.unwrap());
            }
        });
    }
    // 加拿大多语言标准布局的 AltGr+Space 会输入字符：这些用户会在设置页看到「换一个组合」的提示。
    assert_eq!(typing, ["00011009"], "Ctrl+Alt+Space 会输入字符的布局变了");
}
