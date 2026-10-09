//! `TodayService` 的 Use Case 测试：只依赖内存 Fake，直接检验 Today 的语义。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use nivlo_common::clock::FakeClock;
use nivlo_domain::id::ItemId;
use nivlo_domain::item::{DatePoint, Item, ItemType, NewItem, Priority};
use uuid::Uuid;

use super::{TodayService, TodayView};
use crate::testing::FakeUnitOfWork;

/// 测试夹具：服务 + 可播种的内存数据库。
struct Fixture {
    service: TodayService,
    uow: FakeUnitOfWork,
    clock: FakeClock,
    today: NaiveDate,
}

/// 2026-10-09 12:00 UTC 的 UTC 时钟，"今天"是 2026-10-09。
fn utc_fixture() -> Fixture {
    fixture(
        Utc.with_ymd_and_hms(2026, 10, 9, 12, 0, 0).unwrap(),
        Tz::UTC,
    )
}

/// 构造夹具。
fn fixture(now: DateTime<Utc>, timezone: Tz) -> Fixture {
    let uow = FakeUnitOfWork::new();
    let clock = FakeClock::new(now, timezone);
    let today = now.with_timezone(&timezone).date_naive();
    let service = TodayService::new(Arc::new(uow.clone()), Arc::new(clock.clone()));
    Fixture {
        service,
        uow,
        clock,
        today,
    }
}

/// 以序号生成确定性的 ID。
fn id(n: u128) -> ItemId {
    ItemId::from_uuid(Uuid::from_u128(n))
}

/// 构造日期。
fn date(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

/// 创建一个 Item；`scheduled` 为本地日期，`created_minute` 控制创建先后。
fn make(
    n: u128,
    item_type: ItemType,
    title: &str,
    scheduled: Option<NaiveDate>,
    created_minute: u32,
) -> Item {
    let mut new = NewItem::new(item_type, title);
    new.scheduled = scheduled.map(DatePoint::all_day);
    let created = Utc
        .with_ymd_and_hms(2026, 10, 1, 8, created_minute, 0)
        .unwrap();
    Item::create(id(n), new, created).unwrap().0
}

/// 待办标题列表，便于断言。
fn titles(entries: &[super::TodayEntry]) -> Vec<String> {
    entries.iter().map(|e| e.item.title().to_string()).collect()
}

/// 取出视图并断言成功。
async fn today(f: &Fixture) -> TodayView {
    f.service.get_today().await.unwrap()
}

#[tokio::test]
async fn todos_scheduled_today_appear_and_future_or_unscheduled_do_not() {
    let f = utc_fixture();
    f.uow
        .seed(make(1, ItemType::Todo, "今天的", Some(date(10, 9)), 0));
    f.uow
        .seed(make(2, ItemType::Todo, "明天的", Some(date(10, 10)), 1));
    f.uow
        .seed(make(3, ItemType::Todo, "没有日期（在 Inbox）", None, 2));

    let view = today(&f).await;

    assert_eq!(view.date, f.today);
    assert_eq!(titles(&view.todos), ["今天的"]);
    assert!(!view.todos[0].is_overdue);
}

#[tokio::test]
async fn overdue_todos_roll_into_today_with_the_overdue_flag() {
    let f = utc_fixture();
    f.uow
        .seed(make(1, ItemType::Todo, "昨天没做完", Some(date(10, 8)), 0));
    f.uow
        .seed(make(2, ItemType::Todo, "上周没做完", Some(date(10, 2)), 1));
    f.uow
        .seed(make(3, ItemType::Todo, "今天的", Some(date(10, 9)), 2));

    let view = today(&f).await;

    // 没有手动顺序时按计划日期从早到晚：逾期最久的在最前。
    assert_eq!(titles(&view.todos), ["上周没做完", "昨天没做完", "今天的"]);
    assert_eq!(
        view.todos.iter().map(|e| e.is_overdue).collect::<Vec<_>>(),
        [true, true, false]
    );
    assert_eq!(view.remaining_count(), 3);
}

#[tokio::test]
async fn completed_archived_and_non_todo_items_are_not_open_todos() {
    let f = utc_fixture();
    let mut done = make(1, ItemType::Todo, "已完成", Some(date(10, 9)), 0);
    done.complete(Utc.with_ymd_and_hms(2026, 10, 9, 9, 0, 0).unwrap())
        .unwrap();
    let mut archived = make(2, ItemType::Todo, "已归档", Some(date(10, 9)), 1);
    archived
        .archive(Utc.with_ymd_and_hms(2026, 10, 9, 9, 0, 0).unwrap())
        .unwrap();
    f.uow.seed(done);
    f.uow.seed(archived);
    f.uow
        .seed(make(3, ItemType::Note, "笔记", Some(date(10, 9)), 2));

    let view = today(&f).await;

    assert!(view.todos.is_empty());
    assert_eq!(view.remaining_count(), 0);
}

#[tokio::test]
async fn tips_appear_only_on_their_exact_day_and_all_day_tips_come_first() {
    let f = utc_fixture();
    let mut timed = NewItem::new(ItemType::Tip, "15:00 提交周报");
    timed.scheduled = Some(DatePoint::at(
        date(10, 9),
        NaiveTime::from_hms_opt(15, 0, 0).unwrap(),
    ));
    let created = Utc.with_ymd_and_hms(2026, 10, 1, 8, 0, 0).unwrap();
    f.uow.seed(Item::create(id(1), timed, created).unwrap().0);
    f.uow.seed(make(
        2,
        ItemType::Tip,
        "今天服务器维护",
        Some(date(10, 9)),
        1,
    ));
    f.uow
        .seed(make(3, ItemType::Tip, "昨天的提示", Some(date(10, 8)), 2));
    f.uow
        .seed(make(4, ItemType::Tip, "明天的提示", Some(date(10, 10)), 3));

    let view = today(&f).await;

    assert_eq!(titles(&view.tips), ["今天服务器维护", "15:00 提交周报"]);
    // 提示不计入徽标上的数字。
    assert_eq!(view.remaining_count(), 0);
}

#[tokio::test]
async fn todos_completed_today_are_listed_separately_in_completion_order() {
    let f = utc_fixture();
    let mut late = make(1, ItemType::Todo, "下午完成", Some(date(10, 9)), 0);
    late.complete(Utc.with_ymd_and_hms(2026, 10, 9, 11, 0, 0).unwrap())
        .unwrap();
    let mut early = make(2, ItemType::Todo, "上午完成", Some(date(10, 5)), 1);
    early
        .complete(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap())
        .unwrap();
    let mut yesterday = make(3, ItemType::Todo, "昨天完成", Some(date(10, 8)), 2);
    yesterday
        .complete(Utc.with_ymd_and_hms(2026, 10, 8, 20, 0, 0).unwrap())
        .unwrap();
    f.uow.seed(late);
    f.uow.seed(early);
    f.uow.seed(yesterday);

    let view = today(&f).await;

    assert_eq!(titles(&view.completed), ["上午完成", "下午完成"]);
    assert!(view.todos.is_empty());
}

#[tokio::test]
async fn completed_today_uses_the_users_local_day_not_utc() {
    // 上海 2026-10-10 01:00（= UTC 10-09 17:00）。今天是 10-10。
    let f = fixture(
        Utc.with_ymd_and_hms(2026, 10, 9, 17, 0, 0).unwrap(),
        Tz::Asia__Shanghai,
    );
    assert_eq!(f.today, date(10, 10));
    // UTC 10-09 15:00 = 上海 10-09 23:00 → 昨天完成。
    let mut before = make(1, ItemType::Todo, "昨晚完成", Some(date(10, 9)), 0);
    before
        .complete(Utc.with_ymd_and_hms(2026, 10, 9, 15, 0, 0).unwrap())
        .unwrap();
    // UTC 10-09 16:30 = 上海 10-10 00:30 → 今天完成。
    let mut after = make(2, ItemType::Todo, "凌晨完成", Some(date(10, 10)), 1);
    after
        .complete(Utc.with_ymd_and_hms(2026, 10, 9, 16, 30, 0).unwrap())
        .unwrap();
    f.uow.seed(before);
    f.uow.seed(after);

    let view = today(&f).await;

    assert_eq!(titles(&view.completed), ["凌晨完成"]);
}

#[tokio::test]
async fn manual_today_order_wins_and_unordered_todos_are_appended() {
    let f = utc_fixture();
    f.uow
        .seed(make(1, ItemType::Todo, "A", Some(date(10, 9)), 0));
    f.uow
        .seed(make(2, ItemType::Todo, "B", Some(date(10, 9)), 1));
    f.uow
        .seed(make(3, ItemType::Todo, "C", Some(date(10, 9)), 2));
    f.uow
        .seed(make(4, ItemType::Todo, "新加入的", Some(date(10, 9)), 3));
    f.uow
        .seed_today_order(date(10, 9), vec![id(3), id(1), id(2)]);

    let view = today(&f).await;

    assert_eq!(titles(&view.todos), ["C", "A", "B", "新加入的"]);
}

#[tokio::test]
async fn stale_ids_in_the_order_table_are_ignored() {
    let f = utc_fixture();
    f.uow
        .seed(make(1, ItemType::Todo, "A", Some(date(10, 9)), 0));
    f.uow
        .seed(make(2, ItemType::Todo, "B", Some(date(10, 9)), 1));
    // id(99) 不存在；id(2) 之后被推迟到明天，不再属于 Today。
    f.uow
        .seed_today_order(date(10, 9), vec![id(99), id(2), id(1)]);
    let mut moved = make(2, ItemType::Todo, "B", Some(date(10, 9)), 1);
    moved.set_scheduled(Some(DatePoint::all_day(date(10, 10))), Utc::now());
    f.uow.seed(moved);

    let view = today(&f).await;

    assert_eq!(titles(&view.todos), ["A"]);
}

#[tokio::test]
async fn priority_and_due_date_do_not_affect_the_order() {
    let f = utc_fixture();
    let mut low_urgent = make(1, ItemType::Todo, "低优先级但先排", Some(date(10, 9)), 0);
    low_urgent.set_priority(Priority::Low, Utc::now()).unwrap();
    let mut high = make(2, ItemType::Todo, "高优先级排在后面", Some(date(10, 9)), 1);
    high.set_priority(Priority::High, Utc::now()).unwrap();
    high.set_due(Some(DatePoint::all_day(date(10, 9))), Utc::now())
        .unwrap();
    f.uow.seed(low_urgent);
    f.uow.seed(high);
    f.uow.seed_today_order(date(10, 9), vec![id(1), id(2)]);

    let view = today(&f).await;

    assert_eq!(titles(&view.todos), ["低优先级但先排", "高优先级排在后面"]);
}

#[tokio::test]
async fn an_empty_database_gives_an_empty_view() {
    let f = utc_fixture();
    let view = today(&f).await;
    assert!(view.todos.is_empty() && view.tips.is_empty() && view.completed.is_empty());
    assert_eq!(view.remaining_count(), 0);
}

#[tokio::test]
async fn crossing_local_midnight_switches_the_contents_of_today() {
    // 上海 2026-10-09 23:50（UTC 15:50）。
    let f = fixture(
        Utc.with_ymd_and_hms(2026, 10, 9, 15, 50, 0).unwrap(),
        Tz::Asia__Shanghai,
    );
    f.uow
        .seed(make(1, ItemType::Todo, "今天的", Some(date(10, 9)), 0));
    f.uow
        .seed(make(2, ItemType::Todo, "明天的", Some(date(10, 10)), 1));
    f.uow
        .seed(make(3, ItemType::Tip, "明天的提示", Some(date(10, 10)), 2));
    let mut done = make(4, ItemType::Todo, "今晚完成", Some(date(10, 9)), 3);
    done.complete(Utc.with_ymd_and_hms(2026, 10, 9, 15, 0, 0).unwrap())
        .unwrap();
    f.uow.seed(done);

    let before = today(&f).await;
    assert_eq!(before.date, date(10, 9));
    assert_eq!(titles(&before.todos), ["今天的"]);
    assert!(before.tips.is_empty());
    assert_eq!(titles(&before.completed), ["今晚完成"]);

    // 过了本地午夜（UTC 16:00 = 上海 00:00）。
    f.clock.advance(chrono::Duration::minutes(15));
    let after = today(&f).await;

    assert_eq!(after.date, date(10, 10));
    // 昨天没做完的滚入今天并带逾期标记；今天的待办与提示出现；昨晚完成的不再出现。
    assert_eq!(titles(&after.todos), ["今天的", "明天的"]);
    assert_eq!(
        after.todos.iter().map(|e| e.is_overdue).collect::<Vec<_>>(),
        [true, false]
    );
    assert_eq!(titles(&after.tips), ["明天的提示"]);
    assert!(after.completed.is_empty());
}
