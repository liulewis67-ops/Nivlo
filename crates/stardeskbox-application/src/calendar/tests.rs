//! `CalendarService` 的测试：共享测试向量 + 内存 Fake。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::Value;
use stardeskbox_common::clock::FakeClock;
use stardeskbox_domain::item::{DatePoint, ItemType, NewItem};

use super::{
    CalendarService, CalendarView, EntryKind, UNSCHEDULED_LIMIT, WeekStart, visible_range,
};
use crate::item::{ItemService, Patch, UpdateItemInput, next_monday_after};
use crate::settings::SettingsService;
use crate::testing::{FakeUnitOfWork, RecordingPublisher};
use crate::trash::TrashService;

/// 解析 `YYYY-MM-DD`。
fn d(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

/// 与前端共用的测试向量。
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/dates/calendar-ranges.json"
    ))
    .unwrap()
}

#[test]
fn visible_ranges_match_the_shared_vectors() {
    let vectors = vectors();
    for case in vectors["cases"].as_array().unwrap() {
        let view_name = case["view"].as_str().unwrap();
        assert!(
            ["month", "week"].contains(&view_name),
            "未知视图 {view_name}"
        );
        let view = if view_name == "month" {
            CalendarView::Month
        } else {
            CalendarView::Week
        };
        let week_start = WeekStart::parse(case["weekStart"].as_str().unwrap()).unwrap();
        let (from, to) = visible_range(view, d(case["anchor"].as_str().unwrap()), week_start);
        let name = case["name"].as_str().unwrap();
        assert_eq!(from, d(case["from"].as_str().unwrap()), "{name}: from");
        assert_eq!(to, d(case["to"].as_str().unwrap()), "{name}: to");
        let weeks = (to - from).num_days() + 1;
        assert_eq!(weeks % 7, 0, "{name}: 范围必须是整周");
        assert_eq!(weeks / 7, case["weeks"].as_i64().unwrap(), "{name}: weeks");
    }
}

#[test]
fn next_monday_matches_the_shared_vectors() {
    for case in vectors()["nextMonday"].as_array().unwrap() {
        let today = d(case["today"].as_str().unwrap());
        assert_eq!(
            next_monday_after(today),
            d(case["expected"].as_str().unwrap()),
            "{today}"
        );
    }
}

/// 测试夹具。
struct Fixture {
    calendar: CalendarService,
    items: ItemService,
    settings: SettingsService,
    trash: TrashService,
    clock: FakeClock,
}

/// 构造夹具；时钟固定在给定的 UTC 时刻与时区。
fn fixture_at(now: chrono::DateTime<Utc>, timezone: Tz) -> Fixture {
    let uow = FakeUnitOfWork::new();
    let events = Arc::new(RecordingPublisher::new());
    let clock = FakeClock::new(now, timezone);
    Fixture {
        calendar: CalendarService::new(Arc::new(uow.clone()), Arc::new(clock.clone())),
        items: ItemService::new(
            Arc::new(uow.clone()),
            Arc::new(clock.clone()),
            events.clone(),
        ),
        settings: SettingsService::new(Arc::new(uow.clone()), Arc::new(clock.clone())),
        trash: TrashService::new(
            Arc::new(uow),
            Arc::new(clock.clone()),
            events,
            Arc::new(crate::testing::FakeAttachmentFiles::new()),
        ),
        clock,
    }
}

/// 构造夹具；2026-10-14（周三）UTC 08:00。
fn fixture() -> Fixture {
    fixture_at(
        Utc.with_ymd_and_hms(2026, 10, 14, 8, 0, 0).unwrap(),
        Tz::UTC,
    )
}

/// 创建一个带计划（与可选截止）日期的条目。
async fn make(
    f: &Fixture,
    item_type: ItemType,
    title: &str,
    scheduled: Option<DatePoint>,
    due: Option<DatePoint>,
) -> stardeskbox_domain::id::ItemId {
    let mut new = NewItem::new(item_type, title);
    new.scheduled = scheduled;
    new.due = due;
    f.items.create_item(new).await.unwrap().id()
}

#[tokio::test]
async fn entries_are_scheduled_items_plus_a_deadline_overlay_for_open_todos() {
    let f = fixture();
    let both = make(
        &f,
        ItemType::Todo,
        "既有计划又有截止",
        Some(DatePoint::all_day(d("2026-10-14"))),
        Some(DatePoint::all_day(d("2026-10-16"))),
    )
    .await;
    let tip = make(
        &f,
        ItemType::Tip,
        "提示",
        Some(DatePoint::at(
            d("2026-10-14"),
            NaiveTime::from_hms_opt(15, 0, 0).unwrap(),
        )),
        None,
    )
    .await;
    let note = make(
        &f,
        ItemType::Note,
        "笔记",
        Some(DatePoint::all_day(d("2026-10-20"))),
        None,
    )
    .await;
    // 范围之外：不出现。
    make(
        &f,
        ItemType::Todo,
        "范围外",
        Some(DatePoint::all_day(d("2026-12-01"))),
        None,
    )
    .await;

    let data = f
        .calendar
        .get_calendar(CalendarView::Month, d("2026-10-14"))
        .await
        .unwrap();
    assert_eq!((data.from, data.to), (d("2026-09-28"), d("2026-11-01")));
    assert_eq!(data.today, d("2026-10-14"));
    assert_eq!(data.week_start, WeekStart::Monday);
    let seen: Vec<(NaiveDate, EntryKind, _)> = data
        .entries
        .iter()
        .map(|e| (e.date, e.kind, e.item.id()))
        .collect();
    assert_eq!(
        seen,
        [
            // 10-14：全天的待办在有时间的提示之前。
            (d("2026-10-14"), EntryKind::Scheduled, both),
            (d("2026-10-14"), EntryKind::Scheduled, tip),
            // 10-16：截止标记。
            (d("2026-10-16"), EntryKind::Due, both),
            (d("2026-10-20"), EntryKind::Scheduled, note),
        ]
    );
}

#[tokio::test]
async fn completed_todos_stay_on_their_day_but_lose_the_deadline_marker() {
    let f = fixture();
    let id = make(
        &f,
        ItemType::Todo,
        "做完了",
        Some(DatePoint::all_day(d("2026-10-14"))),
        Some(DatePoint::all_day(d("2026-10-15"))),
    )
    .await;
    f.items.complete_item(id).await.unwrap();

    let data = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-14"))
        .await
        .unwrap();
    assert_eq!(data.entries.len(), 1);
    assert_eq!(data.entries[0].kind, EntryKind::Scheduled);
    assert!(data.entries[0].item.is_done());
}

#[tokio::test]
async fn archived_and_deleted_items_never_appear() {
    let f = fixture();
    let deleted = make(
        &f,
        ItemType::Todo,
        "删掉",
        Some(DatePoint::all_day(d("2026-10-14"))),
        None,
    )
    .await;
    make(
        &f,
        ItemType::Todo,
        "留下",
        Some(DatePoint::all_day(d("2026-10-14"))),
        None,
    )
    .await;
    f.trash.delete(&[deleted]).await.unwrap();

    let data = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-14"))
        .await
        .unwrap();
    let titles: Vec<&str> = data
        .entries
        .iter()
        .map(|e| e.item.title().as_str())
        .collect();
    assert_eq!(titles, ["留下"]);
}

#[tokio::test]
async fn the_unscheduled_list_has_open_todos_without_a_date_newest_first() {
    let f = fixture();
    let first = make(&f, ItemType::Todo, "先建的", None, None).await;
    f.clock.advance(Duration::minutes(1));
    let second = make(&f, ItemType::Todo, "后建的", None, None).await;
    make(
        &f,
        ItemType::Todo,
        "有日期",
        Some(DatePoint::all_day(d("2026-10-14"))),
        None,
    )
    .await;
    make(&f, ItemType::Note, "笔记不算", None, None).await;
    let done = make(&f, ItemType::Todo, "已完成", None, None).await;
    f.items.complete_item(done).await.unwrap();

    let data = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-14"))
        .await
        .unwrap();
    let ids: Vec<_> = data.unscheduled.iter().map(|i| i.id()).collect();
    assert_eq!(ids, [second, first]);
}

#[tokio::test]
async fn the_unscheduled_list_is_capped() {
    let f = fixture();
    for n in 0..(UNSCHEDULED_LIMIT + 5) {
        make(&f, ItemType::Todo, &format!("待安排 {n}"), None, None).await;
    }
    let data = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-14"))
        .await
        .unwrap();
    assert_eq!(data.unscheduled.len(), UNSCHEDULED_LIMIT as usize);
}

#[tokio::test]
async fn the_week_start_setting_changes_the_visible_range() {
    let f = fixture();
    let monday = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-18"))
        .await
        .unwrap();
    assert_eq!((monday.from, monday.to), (d("2026-10-12"), d("2026-10-18")));

    f.settings.set_week_start(WeekStart::Sunday).await.unwrap();
    let sunday = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-18"))
        .await
        .unwrap();
    assert_eq!(sunday.week_start, WeekStart::Sunday);
    assert_eq!((sunday.from, sunday.to), (d("2026-10-18"), d("2026-10-24")));
}

#[tokio::test]
async fn today_follows_the_user_time_zone_not_utc() {
    // UTC 2026-10-14 20:00 在东京已经是 10-15 05:00，在洛杉矶是 10-14 13:00。
    let now = Utc.with_ymd_and_hms(2026, 10, 14, 20, 0, 0).unwrap();
    let tokyo = fixture_at(now, Tz::Asia__Tokyo);
    let la = fixture_at(now, Tz::America__Los_Angeles);
    let today = |f: &Fixture| {
        let calendar = f.calendar.clone();
        async move {
            calendar
                .get_calendar(CalendarView::Week, d("2026-10-14"))
                .await
                .unwrap()
                .today
        }
    };
    assert_eq!(today(&tokyo).await, d("2026-10-15"));
    assert_eq!(today(&la).await, d("2026-10-14"));
}

#[tokio::test]
async fn rescheduling_moves_an_item_between_days_and_keeps_its_time() {
    let f = fixture();
    let id = make(
        &f,
        ItemType::Tip,
        "站会",
        Some(DatePoint::at(
            d("2026-10-14"),
            NaiveTime::from_hms_opt(10, 30, 0).unwrap(),
        )),
        None,
    )
    .await;
    f.items
        .update_item(
            id,
            UpdateItemInput {
                scheduled: Patch::Set(DatePoint::at(
                    d("2026-10-16"),
                    NaiveTime::from_hms_opt(10, 30, 0).unwrap(),
                )),
                ..UpdateItemInput::default()
            },
        )
        .await
        .unwrap();
    let data = f
        .calendar
        .get_calendar(CalendarView::Week, d("2026-10-14"))
        .await
        .unwrap();
    assert_eq!(data.entries[0].date, d("2026-10-16"));
    assert_eq!(
        data.entries[0].item.scheduled().unwrap().time(),
        NaiveTime::from_hms_opt(10, 30, 0)
    );
}
