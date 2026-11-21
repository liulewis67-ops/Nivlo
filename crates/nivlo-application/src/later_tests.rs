//! 「稍后」的规则（实施计划 3.5）：设置如何影响悬浮窗与收集箱的「稍后」。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{NaiveDate, TimeZone, Utc};
use nivlo_common::clock::FakeClock;
use nivlo_domain::item::{ItemType, NewItem};

use crate::inbox::{InboxService, OrganizeAction, ScheduleTarget};
use crate::item::{ItemService, RescheduleTarget};
use crate::settings::{LaterRule, SettingsService, keys};
use crate::testing::{FakeUnitOfWork, RecordingPublisher};

/// 2026-10-09 是周五。
fn friday() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 9).unwrap()
}

/// 测试夹具。
struct Fixture {
    items: ItemService,
    inbox: InboxService,
    settings: SettingsService,
}

/// 构造夹具；时钟固定在周五（UTC 08:00，本地同一天）。
fn fixture() -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
    Fixture {
        items: ItemService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        inbox: InboxService::new(Arc::new(uow.clone()), Arc::new(clock.clone()), events),
        settings: SettingsService::new(Arc::new(uow), Arc::new(clock)),
    }
}

#[test]
fn rules_resolve_relative_to_today() {
    // 周五：下周一是 3 天后，与「三天后」同一天；用周日验证两者不同。
    assert_eq!(
        LaterRule::NextMonday.resolve(friday()),
        NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()
    );
    let sunday = NaiveDate::from_ymd_opt(2026, 10, 11).unwrap();
    assert_eq!(
        LaterRule::NextMonday.resolve(sunday),
        NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()
    );
    assert_eq!(
        LaterRule::InThreeDays.resolve(sunday),
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap()
    );
    assert_eq!(
        LaterRule::InOneWeek.resolve(friday()),
        NaiveDate::from_ymd_opt(2026, 10, 16).unwrap()
    );
}

#[test]
fn rules_round_trip_through_their_stored_text() {
    for rule in [
        LaterRule::NextMonday,
        LaterRule::InThreeDays,
        LaterRule::InOneWeek,
    ] {
        assert_eq!(LaterRule::parse(rule.as_str()), Some(rule));
    }
    assert_eq!(LaterRule::parse("tomorrow-ish"), None);
}

#[tokio::test]
async fn the_default_is_next_monday_and_unknown_values_fall_back_to_it() {
    let f = fixture();
    assert_eq!(
        f.settings.later_rule().await.unwrap(),
        LaterRule::NextMonday
    );
    f.settings.set(keys::LATER_RULE, "garbage").await.unwrap();
    assert_eq!(
        f.settings.later_rule().await.unwrap(),
        LaterRule::NextMonday
    );
}

#[tokio::test]
async fn reschedule_later_follows_the_setting() {
    let f = fixture();
    let item = f
        .items
        .create_item(NewItem::new(ItemType::Todo, "稍后做"))
        .await
        .unwrap();

    let moved = f
        .items
        .reschedule_item(item.id(), RescheduleTarget::Later)
        .await
        .unwrap();
    assert_eq!(
        moved.scheduled().unwrap().date(),
        NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()
    );

    f.settings
        .set_later_rule(LaterRule::InOneWeek)
        .await
        .unwrap();
    let moved = f
        .items
        .reschedule_item(item.id(), RescheduleTarget::Later)
        .await
        .unwrap();
    assert_eq!(
        moved.scheduled().unwrap().date(),
        NaiveDate::from_ymd_opt(2026, 10, 16).unwrap()
    );
}

#[tokio::test]
async fn the_inbox_later_button_follows_the_setting_too() {
    let f = fixture();
    let item = f
        .items
        .create_item(NewItem::new(ItemType::Todo, "收集箱里的"))
        .await
        .unwrap();
    f.settings
        .set_later_rule(LaterRule::InOneWeek)
        .await
        .unwrap();
    let outcome = f
        .inbox
        .organize(
            &[item.id()],
            OrganizeAction::Schedule(ScheduleTarget::Later),
        )
        .await
        .unwrap();
    assert_eq!(
        outcome.items[0].scheduled().unwrap().date(),
        NaiveDate::from_ymd_opt(2026, 10, 16).unwrap()
    );
}
