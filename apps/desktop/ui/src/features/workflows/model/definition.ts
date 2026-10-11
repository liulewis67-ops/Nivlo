/** 表单编辑器能理解的匹配字段。 */
export const CONDITION_FIELDS = [
  "input.type",
  "url.host",
  "url.path",
  "url.scheme",
  "file.extension",
  "file.name",
  "text",
  "source.application",
] as const;

/** 表单编辑器能理解的比较方式。 */
export const CONDITION_OPS = [
  "equals",
  "contains",
  "startsWith",
  "endsWith",
  "glob",
  "regex",
  "exists",
] as const;

/** 创建出来的条目类型。 */
export const ITEM_TYPES = ["todo", "note", "tip"] as const;

/** `input.type` 的取值。 */
export const INPUT_TYPES = ["text", "url", "file", "files", "image"] as const;

/** 一个匹配条件（表单形态）。 */
export type ConditionForm = {
  /** 字段，如 `url.host`。 */
  field: string;
  /** 比较方式。 */
  op: string;
  /** 比较的值；`exists` 不需要。 */
  value: string;
};

/** 表单编辑器编辑的内容。 */
export type WorkflowForm = {
  /** 名称。 */
  name: string;
  /** 说明。 */
  description: string;
  /** 全部满足才匹配的条件（至少一个）。 */
  conditions: ConditionForm[];
  /** 创建的条目类型。 */
  itemType: string;
  /** 标题模板。 */
  title: string;
  /** 内容模板。 */
  content: string;
  /** 标签，逗号分隔。 */
  tags: string;
  /** 是否先进入收集箱。 */
  inInbox: boolean;
  /** 是否安排在今天（待办 / 提示）。 */
  scheduledToday: boolean;
};

/** 定义里 JSON 对象的宽松形态。 */
type Json = Record<string, unknown>;

/**
 * 是否是普通对象。
 *
 * @param value 任意值。
 * @returns 是对象（非数组、非 `null`）时为 `true`。
 */
function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把一个叶子条件还原成表单形态；不是简单的叶子条件返回 `null`。
 *
 * @param value 定义里的条件。
 * @returns 表单条件，或 `null`。
 */
function leafToForm(value: unknown): ConditionForm | null {
  if (!isObject(value) || typeof value.field !== "string" || typeof value.op !== "string") {
    return null;
  }
  return {
    field: value.field,
    op: value.op,
    value: typeof value.value === "string" ? value.value : "",
  };
}

/**
 * 取出定义里的条件列表；只认「单个条件」与「全部满足」两种形态，其他返回 `null`。
 *
 * @param matcher 定义里的匹配器。
 * @returns 条件列表，或 `null`（表单无法表示，要用 JSON 编辑）。
 */
function conditionsOf(matcher: unknown): ConditionForm[] | null {
  const single = leafToForm(matcher);
  if (single !== null) return [single];
  if (isObject(matcher) && Array.isArray(matcher.all) && Object.keys(matcher).length === 1) {
    const leaves = matcher.all.map(leafToForm);
    if (leaves.length > 0 && leaves.every((leaf) => leaf !== null)) return leaves;
  }
  return null;
}

/**
 * 找到唯一的 `createItem` Step 的位置；没有或有多个返回 `-1`。
 *
 * @param steps 定义里的 Step 列表。
 * @returns 下标。
 */
function createItemIndex(steps: unknown): number {
  if (!Array.isArray(steps)) return -1;
  const found = steps
    .map((step, index) => (isObject(step) && step.type === "createItem" ? index : -1))
    .filter((index) => index >= 0);
  return found.length === 1 ? (found[0] ?? -1) : -1;
}

/**
 * 解析定义 JSON；不是合法的 JSON 对象返回 `null`。
 *
 * @param json 定义文本。
 * @returns 对象，或 `null`。
 */
export function parseDefinition(json: string): Json | null {
  try {
    const value: unknown = JSON.parse(json);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把定义转成表单；表单表示不了的定义（嵌套条件、多个 createItem、`forEach` 等）返回 `null`，
 * 此时只能用 JSON 编辑，避免表单悄悄丢掉用户的内容。
 *
 * @param definition 已解析的定义。
 * @returns 表单，或 `null`。
 */
export function toForm(definition: Json): WorkflowForm | null {
  const conditions = conditionsOf(definition.matcher);
  const at = createItemIndex(definition.steps);
  if (conditions === null || at < 0) return null;
  const step = (definition.steps as Json[])[at];
  if (step === undefined || step.forEach !== undefined || step.priority !== undefined) return null;
  const scheduled = step.scheduled;
  if (scheduled !== undefined && scheduled !== "{{ now.date }}") return null;
  return {
    name: typeof definition.name === "string" ? definition.name : "",
    description: typeof definition.description === "string" ? definition.description : "",
    conditions,
    itemType: typeof step.itemType === "string" ? step.itemType : "note",
    title: typeof step.title === "string" ? step.title : "",
    content: typeof step.content === "string" ? step.content : "",
    tags: Array.isArray(step.tags) ? step.tags.filter((t) => typeof t === "string").join(", ") : "",
    inInbox: step.inInbox !== false,
    scheduledToday: scheduled === "{{ now.date }}",
  };
}

/**
 * 把表单的修改写回定义：只改表单负责的部分，其余字段（ID、优先级、其他 Step）原样保留。
 *
 * @param definition 原来的定义。
 * @param form 表单内容。
 * @returns 新的定义。
 */
export function applyForm(definition: Json, form: WorkflowForm): Json {
  const leaves = form.conditions.map((condition) =>
    condition.op === "exists"
      ? { field: condition.field, op: condition.op }
      : { field: condition.field, op: condition.op, value: condition.value },
  );
  const steps = Array.isArray(definition.steps) ? [...(definition.steps as Json[])] : [];
  const at = createItemIndex(steps);
  const previous = at >= 0 ? (steps[at] ?? {}) : {};
  const tags = form.tags
    .split(/[,，]/)
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter((tag) => tag !== "");
  const created: Json = { ...previous, type: "createItem", itemType: form.itemType };
  created.title = form.title;
  if (form.content.trim() === "") delete created.content;
  else created.content = form.content;
  created.inInbox = form.inInbox;
  if (tags.length === 0) delete created.tags;
  else created.tags = tags;
  if (form.scheduledToday && form.itemType !== "note") created.scheduled = "{{ now.date }}";
  else delete created.scheduled;
  if (at >= 0) steps[at] = created;
  else steps.push(created);
  return {
    ...definition,
    name: form.name,
    description: form.description,
    matcher: leaves.length === 1 ? leaves[0] : { all: leaves },
    steps,
  };
}

/**
 * 格式化成缩进的 JSON 文本。
 *
 * @param definition 定义对象。
 * @returns JSON 文本。
 */
export function stringify(definition: Json): string {
  return JSON.stringify(definition, null, 2);
}

/**
 * 用一句话概括匹配条件（列表与只读视图使用）。
 *
 * @param matcher 定义里的匹配器。
 * @returns 描述；无法概括时返回 `null`。
 */
export function describeMatcher(matcher: unknown): string | null {
  const conditions = conditionsOf(matcher);
  if (conditions !== null) {
    return conditions
      .map((c) => (c.op === "exists" ? `${c.field} 存在` : `${c.field} ${c.op} ${c.value}`))
      .join(" 且 ");
  }
  if (isObject(matcher) && Array.isArray(matcher.any)) {
    const parts = matcher.any.map(leafToForm);
    if (parts.every((p) => p !== null)) {
      return parts.map((c) => `${c.field} ${c.op} ${c.value}`).join(" 或 ");
    }
  }
  return null;
}

/**
 * 新建 Workflow 的初始定义：匹配网址，创建一条带标签的待办，可直接保存。
 *
 * @param id 新 Workflow 的 ID。
 * @returns 定义对象。
 */
export function blankDefinition(id: string): Json {
  return {
    schemaVersion: 1,
    id,
    name: "新的 Workflow",
    description: "",
    priority: 10,
    enabled: true,
    source: "user",
    matcher: { field: "input.type", op: "equals", value: "url" },
    steps: [
      {
        type: "createItem",
        itemType: "todo",
        title: "{{ input.title }}",
        content: "{{ input.url }}",
        inInbox: true,
      },
    ],
  };
}

/**
 * 由名称生成不冲突的用户 Workflow ID。
 *
 * @param taken 已有的 ID。
 * @returns `user.workflow` / `user.workflow-2` …
 */
export function freshId(taken: readonly string[]): string {
  let n = 1;
  let id = "user.workflow";
  while (taken.includes(id)) {
    n += 1;
    id = `user.workflow-${n}`;
  }
  return id;
}
