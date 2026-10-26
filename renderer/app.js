/* FGO牵绊推荐器 - Phase4 前端（Vue 3 global build）
 *
 * 交互模型（已确认）：
 * - 主页面 6 个槽位，每个槽位 = 上从者 + 下礼装。
 * - 用户主动填写 = 固定；空槽位 = 自由（算法可填）。
 * - 助战是独立于固定/自由的一组状态；非助战不显示标签。
 * - 结果展示在当前页面下方，滚轮下滑查看。
 * - UI 个人加成用百分比存储，调用引擎前转小数。
 */
"use strict";

const { createApp } = Vue;

// contextBridge 在 main world → preload world 之间传参时使用 structured clone，
// Vue reactive Proxy 无法被克隆。必须在调用 window.fgo.* 之前先转成普通 JSON 数据。
function plainClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

const POSITION_KEYS = [
  "front_left",
  "front_middle",
  "front_right",
  "back_left",
  "back_middle",
  "back_right",
];

const STAGES = ["initial", "first", "second", "third", "fourth"];
const STAGE_LABELS = { initial: "初始", first: "一破", second: "二破", third: "三破", fourth: "满破" };
const CLASSES = [
  "Saber", "Archer", "Lancer", "Rider", "Caster", "Assassin", "Berserker",
  "Ruler", "Avenger", "AlterEgo", "MoonCancer", "Foreigner", "Pretender", "Shielder",
  "Beast",
];

// 戴冠战一级职阶筛选
const CROWN_CLASS_FILTERS = [
  { value: "all", label: "不限职阶" },
  { value: "saber", label: "剑" },
  { value: "archer", label: "弓" },
  { value: "lancer", label: "枪" },
  { value: "rider", label: "骑" },
  { value: "caster", label: "术" },
  { value: "assassin", label: "杀" },
  { value: "berserker", label: "狂" },
  { value: "ex1", label: "EX1（尺仇月盾）" },
  { value: "ex2", label: "EX2（他批降兽）" },
  { value: "exall", label: "全EX（EX1+EX2）" },
];

const CROWN_CLASS_GROUPS = {
  all: null,
  saber: ["Saber"],
  archer: ["Archer"],
  lancer: ["Lancer"],
  rider: ["Rider"],
  caster: ["Caster"],
  assassin: ["Assassin"],
  berserker: ["Berserker"],
  ex1: ["Ruler", "Avenger", "MoonCancer", "Shielder"],
  ex2: ["AlterEgo", "Foreigner", "Pretender", "Beast", "beastEresh", "unBeastOlgaMarie"],
  // 全EX = EX1 + EX2（游戏里 Extra 是一个职阶，戴冠战按这个口径打时要把两组都算进来）
  exall: [
    "Ruler",
    "Avenger",
    "MoonCancer",
    "Shielder",
    "AlterEgo",
    "Foreigner",
    "Pretender",
    "Beast",
    "beastEresh",
    "unBeastOlgaMarie",
  ],
};

function formatBondNumber(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

// 本地已下载的牵绊礼装图（equipFace，JP 数据）
const CRAFT_IMAGE_IDS = new Set([
  9401970, 9403520, 9404310, 9405110, 9405710,
  9405720, 9405730, 9407110, 9407480, 9407740,
  9407850, 9408060, 9408220, 9408390, 9408590,
  9408800, 9408990, 9409210, 9409320, 9409490,
]);

const POSITION_LABELS = {
  front_left: "位1",
  front_middle: "位2",
  front_right: "位3",
  back_left: "位4",
  back_middle: "位5",
  back_right: "位6",
};

// 通用牵绊礼装：英灵肖像/英灵逢魔/英灵极点。
// 默认不参与自动搜索；手动放置仍计算。可在礼装选择列表右键切换参与。
const GENERIC_BOND_CRAFT_IDS = [-20, -21, -22];
const GENERIC_BOND_CRAFT_DEFS = [
  {
    id: -20,
    name: "通用英灵肖像",
    rarity: 4,
    cost: 5,
    bonusType: "universal",
    bonusValue: 0,
    flatBonus: 50,
    triggerTraits: [],
    detail: "关卡通关时获得的牵绊值固定 +50（无条件）",
  },
  {
    id: -21,
    name: "通用英灵逢魔",
    rarity: 4,
    cost: 9,
    bonusType: "trait",
    bonusValue: 0.1,
    flatBonus: 0,
    triggerTraits: [["FSNServant"]],
    detail: "关卡通关时获得的〔Fate/stay night从者〕牵绊值提升10%",
  },
  {
    id: -22,
    name: "通用英灵极点",
    rarity: 4,
    cost: 9,
    bonusType: "universal",
    bonusValue: 0.02,
    flatBonus: 0,
    triggerTraits: [],
    detail: "关卡通关时获得的牵绊值提升2%（英灵极点系列通用）",
  },
];

// 常用 trait key -> 中文显示（先用本地 Chaldea 生成的完整映射，再用常用项覆盖成更简短的名称）
const TRAIT_LABELS = Object.assign({}, window.TRAIT_NAMES || {}, {
  alignmentGood: "善",
  alignmentEvil: "恶",
  alignmentLawful: "秩序",
  alignmentChaotic: "混沌",
  alignmentNeutral: "中立",
  attributeEarth: "地属性",
  attributeSky: "天属性",
  attributeStar: "星属性",
  attributeMan: "人属性",
  attributeBeast: "兽属性",
  genderMale: "男性",
  genderFemale: "女性",
  genderUnknown: "性别不明",
  classSaber: "剑阶",
  classArcher: "弓阶",
  classLancer: "枪阶",
  classRider: "骑阶",
  classCaster: "术阶",
  classAssassin: "杀阶",
  classBerserker: "狂阶",
  classRuler: "裁定者",
  classAvenger: "复仇者",
  classAlterEgo: "Alterego",
  classMoonCancer: "MoonCancer",
  classForeigner: "降临者",
  classPretender: "Pretender",
  classShielder: "盾阶",
  classBeast: "Beast",
  beast: "Beast",
  beastEresh: "Beast",
  unBeastOlgaMarie: "Beast",
  servant: "从者",
  humanoid: "人型",
  hominidaeServant: "人科从者",
  demonicBeastServant: "魔兽型从者",
  havingAnimalsCharacteristics: "兽科",
  canBeInBattle: "可战斗",
  fiveStarServant: "5星从者",
  fourStarServant: "4星从者",
  threeStarServant: "3星从者",
  dragon: "龙",
  king: "王",
  riding: "骑乘",
  saberface: "Saber脸",
  arthur: "亚瑟",
  knightsOfTheRound: "圆桌骑士",
  skyOrEarthServant: "天或地从者",
  skyOrEarthExceptPseudoAndDemiServant: "天或地（除拟似/亚从者）",
  livingHuman: "活在当下的人类",
  hasCostume: "拥有灵衣之人",
  FSNServant: "FSN从者",
  weakToEnumaElish: "对Enuma Elish弱点",
});

// 默认第 3 个位置（front_right）为助战位
function makeSlots() {
  return Array.from({ length: 6 }, (_, i) => ({
    servantId: null,
    craftId: null,
    secondCraftId: null,
    isSupport: i === 2,
    stage: null,
    isCrown: false,
  }));
}

/**
 * 手册文本里的行内标记（目前只支持 **加粗**）→ 安全的 HTML。
 * 先转义再插入自己的 <b>，所以不会因为手册内容而注入标签。
 */
function manualInlineHtml(text) {
  const escaped = String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/**
 * 把「使用说明」的纯文本切成 章节 → 行块，供界面阅读用（够用即可，不做完整 Markdown）。
 * 文本来源：window.FGO_MANUAL_TEXT（由 scripts/make_manual_js.mjs 从 使用说明.txt 生成）。
 */
function parseManual(raw) {
  const CHAPTER = /^[一二三四五六七八九十百]+、/;
  const SEPARATOR = /^[─—\-=]{4,}$/;
  const sections = [];
  let cur = null;
  for (const rawLine of String(raw || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const text = line.trim();
    if (SEPARATOR.test(text)) continue;
    if (!text) {
      if (cur && cur.blocks.length) cur.blocks.push({ kind: "gap", text: "" });
      continue;
    }
    if (CHAPTER.test(text)) {
      cur = { title: text, blocks: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: "使用说明", blocks: [] };
      sections.push(cur);
    }
    const depth = Math.min(1, Math.floor((line.length - line.trimStart().length) / 2));
    let kind = "text";
    let body = text;
    if (/^【.+】$/.test(text)) {
      kind = "sub";
    } else if (/^[·•]\s*/.test(text)) {
      kind = "bullet";
      body = text.replace(/^[·•]\s*/, "");
    } else if (/^[-*]\s+/.test(text)) {
      kind = "bullet";
      body = text.replace(/^[-*]\s+/, "");
    } else if (/^\d+[).、]\s*/.test(text) || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/.test(text)) {
      kind = "bullet";
    }
    cur.blocks.push({ kind, text: body, depth });
  }
  for (const s of sections) {
    while (s.blocks.length && s.blocks[s.blocks.length - 1].kind === "gap") s.blocks.pop();
  }
  return sections.filter((s) => s.blocks.length);
}

const App = {
  data() {
    return {
      loading: true,
      error: "",
      info: null,
      costumeNames: {},
      avatarBroken: [],
      localAvatars: {}, // 运行时补下来的头像（id -> data URL）
      avatarTried: {}, // 已经尝试补过的 id（避免反复请求）
      diagLogText: "", // 诊断日志（宿主提供 getDiagnosticLog 时才用）
      diagLogLines: 0,
      diagLogLoaded: false,
      diagLogNote: "",
      servants: [],
      // 同分替补重算个体数值用：从者 id -> { 形态键: [特性...] }（懒加载 + 缓存）
      servantForms: {},
      servantFormsLoading: {},
      bondCrafts: [],
      otherCrafts: [],
      allCrafts: [],
      box: {}, // id -> {checked, stage, maxBond, switch1, switch2, personalBonus}
      boxFilter: { keyword: "", class: "all", rarity: "all", owned: "all", maxBond: "all" },
      batchBonus: 0,
      slots: makeSlots(),
      dragState: { type: null, slotIndex: null, craftIndex: null },
      dragOverSlot: null,
      dragOverCraft: null,
      mode: "normal",
      serverRegion: "jp",
      cnUnavailableCraftIds: [],
      // 简中服尚未实装的可玩从者：简中模式下要从候选池里剔除（日服照常）
      cnUnavailableServantIds: [],
      genericParticipatingCraftIds: [],
      nonParticipatingCraftIds: [],
      customCrafts: [],
      customModalVisible: false,
      customEditing: null,
      customDraft: null,
      customTraitInputs: [],
      crownClass: "all",
      baseBond: 0,
      // 排序口径（= 搜索目标）：默认按倍率；选了"按点数"且填了基础牵绊才按点数
      sortMode: "multiplier",
      costLimit: 116,
      strategy: "total_max",
      qualityMode: "balanced",
      // 超级模式（扩大覆盖版）：0 = 关闭；2.5 / 5 / 10 = 覆盖倍数。
      // 开启后"计算档位 / 结果完整度 / 邻域"由它接管（固定走最大覆盖、不设时间上限）。
      superLevel: 0,
      superProgress: null,
      superStopping: false,
      superPartial: false,
      targetServantId: null,
      targetServantKeyword: "",
      overlay: { visible: false, slotIndex: null, target: "servant", craftIndex: 0, keyword: "", classFilter: "all", rarityFilter: "all", ownedOnly: true, craftType: "bond", sortBy: "collectionNo", sortOrder: "desc" },
      boxModalVisible: false,
      exclusionModalVisible: false,
      exclusionTab: "servant",
      exclusionKeyword: "",
      exclusionClass: "all",
      exclusionRarity: "all",
      exclusionMaxBond: "all",
      exclusionSortBy: "collectionNo",
      exclusionSortOrder: "desc",
      exclusionCraftKeyword: "",
      excludedServants: [],
      excludedCrafts: [],
      batchModalVisible: false,
      batchSelectedServants: [],
      // 按住滑动批量选择（仅电脑端鼠标）的"预览状态"：id(字符串) -> 目标状态
      // 拖动过程中只改这里，松手才一次性提交，避免列表被筛选条件抽走导致选中范围错乱
      dragSelectPending: {},
      eventBondBonuses: [],
      selectedEventId: null,
      batchImportMessage: "",
      teamModalVisible: false,
      contextMenu: { visible: false, x: 0, y: 0, slotIndex: null, target: null, result: null, member: null },
      hover: { visible: false, x: 0, y: 0, text: "" },
      servantDetail: { visible: false, servantId: null, slotIndex: null },
      servantDetailEventId: "",
      servantAttr: { visible: false, servantId: null, stage: "fourth", rows: [], loading: false },
      presets: [],
      presetModalVisible: false,
      // 预设改名：正在改哪一条（id）、草稿名（回车/失焦保存，Esc 取消）
      renamingPresetId: null,
      renameDraft: "",
      presetSaveVisible: false,
      presetName: "",
      // 「同时保存本次结果」（默认勾上，2026-10-14 用户定）：有结果才显示这个勾选框
      presetSaveWithResult: true,
      // 最近一次计算的完整快照（用于"保存计算结果"）；打开存档结果时也会指向它
      lastResultSnapshot: null,
      // 当前结果区显示的是"库里的存档结果"时记下来（时间 / 数据版本），用于提示与版本对比
      loadedResultInfo: null,
      // 多账号（一个账号 = 一套 Box + 一套排除列表）
      accounts: [],
      activeAccountId: null,
      accountBusy: false,
      accountModalVisible: false,
      accountError: "",
      newAccountName: "",
      newAccountCopyFromCurrent: false,
      accountEditingId: null,
      accountEditingName: "",
      calculating: false,
      progress: "",
      results: [],
      totalCandidates: 0,
      verificationMode: "repro",
      verificationTokens: [],
      verificationTokensFull: [],
      verificationCopied: false,
      settingsVisible: false,
      // 使用说明（应用内阅读；内容来自 renderer/manual.js ← 使用说明.txt）
      manualVisible: false,
      manualActive: 0,
      // PC 端：左上角「设置 ▾」下拉（安卓没有系统菜单，仍用工具栏「设置」按钮开全部分区）
      settingsMenuOpen: false,
      // 当前打开的是哪一区：all（安卓）/ calc 计算设置 / display 结果显示设置 / diag 诊断日志
      settingsSection: "all",
      // 邻域优化档位（v0.1.14 新增）：算完后把靠前队伍互相"换人"再算，捞"混血"更优解。
      // off / standard / deep；跟随队伍预设一起保存与加载。
      neighborhood: "standard",
      resultSettings: {
        // 结果完整度（原名「搜索顺序」，2026-10-07 改名；字段名沿用 searchOrder 以兼容老预设）：
        // 只决定"要不要多跑一趟礼装优先覆盖"——
        //   craft   —— 更全（默认）：多跑一趟（约 +15%），能多出"几个人一起吃同一批礼装"的队伍
        //   servant —— 更快：不跑那趟，常规最优解都在、第 1 名不变
        searchOrder: "craft",
        autoExpandFirst: false,
        showSearchStats: false,
        showBonusFormula: false,
        showCostBreakdown: false,
        showCraftTriggers: true,
        showCraftHits: false,
        showDataVersion: false,
        showResultBondBadge: false,
        hideEmptyCraftSlots: false,
        hideSupport: false,
        compareMode: false,
        feedbackMode: "brief",
        pageSize: 50,
        // 结果条数同时也是引擎的"搜索止损线"：条数越多，剪枝越晚生效、算得越慢 → 默认 200
        resultTopN: 200,
        // 活动从者优先（2026-10-14 新增）：把"个人加成不足 50%"的从者也一并优先纳入。
        // 个人加成 ≥50% 的从者**始终**优先纳入，与此开关无关（引擎侧规则）。
        eventPriority: false,
        // 「全部视为非满绊」（2026-10-14 新增，玩家需求）：为"该给谁喂梦火"服务。
        // 打开后所有从者都按"还能继续涨"算（= 引擎的「自身参与收益」一律为真）；
        // 「15 级以上的全队 +25%」按等级照常给，**不受这个开关影响**。
        ignoreMaxBond: false,
      },
      compareSelectedRanks: [],
      compareVisible: false,
      lastSearchStats: null,
      expandedResult: null,
      // 同分可替换阵容：rank → 选中的条目下标（0 = 引擎给的那一支）
      sameScoreChoice: {},
      // 同分下拉里"展开全部"的状态：rank → true（默认只列前 20 支）
      sameScoreExpanded: {},
      // 当前展开了"同分"下拉的方案序号
      expandedSameScore: null,
      simpleExcludedServants: [],
      currentPage: 1,
      pageSize: 50,
      resultInfo: { visible: false, mode: "", title: "", subtitle: "", rows: [] },
      updateModalVisible: false,
      updateRunning: false,
      updateTitle: "更新数据",
      updateItems: [],
      updateResult: null,
      updateError: "",
      // 版本与更新信息（点左上角标题进入）：只查版本号，不下载
      appUpdate: null,
      appUpdateChecking: false,
      appUpdateError: "",
    };
  },
  computed: {
    /** 超级模式是否开启（覆盖倍数 > 1） */
    superOn() {
      return Number(this.superLevel) > 1;
    },
    /** 使用说明的章节（内容来自 renderer/manual.js，由 使用说明.txt 生成） */
    manualSections() {
      return parseManual(typeof window !== "undefined" ? window.FGO_MANUAL_TEXT : "");
    },
    /** 简中服未实装从者的 id 集合（日服模式下为空集，等于不生效） */
    cnUnavailableServantSet() {
      if (this.serverRegion !== "cn") return new Set();
      return new Set((this.cnUnavailableServantIds || []).map(Number));
    },
    /** 当前服务器下可见的从者（简中模式会隐藏简中服尚未实装的那些） */
    visibleServants() {
      const hidden = this.cnUnavailableServantSet;
      if (!hidden.size) return this.servants;
      return this.servants.filter((s) => !hidden.has(Number(s.id)));
    },
    ownedServants() {
      return this.visibleServants.filter((s) => this.box[s.id] && this.box[s.id].checked);
    },
    universal5Craft() {
      return {
        id: -10,
        name: "通用5%",
        rarity: 5,
        cost: 12,
        bonusType: "universal",
        bonusValue: 0.05,
        supportBonus: 0,
        isBondCe: true,
        isEventLimited: false,
        craftType: "bond",
        detail: "关卡通关时获得的牵绊点数提升5%（可重复布置）",
      };
    },
    meaningfulBondCrafts() {
      // 只保留有意义的牵绊礼装：排除活动限定、排除满破2.5%及以下、排除英灵逢魔系列；
      // 普通 5% 通用礼装合并为一个可重复的“通用5%”。
      const actual = this.bondCrafts.filter(
        (c) =>
          !c.isEventLimited &&
          (c.bonusValue || 0) > 0.025 &&
          !String(c.name || "").includes("英灵逢魔") &&
          !this.isGenericUniversal5Actual(c) &&
          !this.isCnUnavailableCraft(c)
      );
      // 自定义牵绊礼装直接并入可选库，不再做 2.5% 门槛/合并通用5%处理
      const custom = this.enabledCustomBondCrafts.filter(
        (c) => c.id !== -10 && !this.isGenericUniversal5Actual(c)
      );
      return [this.universal5Craft, ...actual, ...custom, ...this.genericBondCrafts];
    },
    otherCraftOptions() {
      const synthetic = [
        { id: 0, name: "没有（无礼装）", rarity: 0, cost: 0, detail: "不装备礼装" },
        { id: -1, name: "其他礼装(1★)", rarity: 1, cost: 1, detail: "无牵绊加成，仅占 Cost 1" },
        { id: -2, name: "其他礼装(2★)", rarity: 2, cost: 3, detail: "无牵绊加成，仅占 Cost 3" },
        { id: -3, name: "其他礼装(3★)", rarity: 3, cost: 5, detail: "无牵绊加成，仅占 Cost 5" },
        { id: -4, name: "其他礼装(4★)", rarity: 4, cost: 9, detail: "无牵绊加成，仅占 Cost 9" },
        { id: -5, name: "其他礼装(5★)", rarity: 5, cost: 12, detail: "无牵绊加成，仅占 Cost 12" },
      ];
      return [...synthetic, ...this.enabledCustomOtherCrafts];
    },
    enabledCustomBondCrafts() {
      return (this.customCrafts || [])
        .filter((c) => c.craftType === "bond" && c.enabled)
        .map((c) => this.customToCraft(c));
    },
    enabledCustomOtherCrafts() {
      return (this.customCrafts || [])
        .filter((c) => c.craftType === "other" && c.enabled)
        .map((c) => this.customToCraft(c));
    },
    genericBondCrafts() {
      return GENERIC_BOND_CRAFT_DEFS.map((def) => ({
        id: def.id,
        name: def.name,
        rarity: def.rarity,
        cost: def.cost,
        bonusType: def.bonusType,
        bonusValue: def.bonusValue,
        supportBonus: 0,
        triggerTraitsJson: JSON.stringify(def.triggerTraits || []),
        detail: def.detail,
        isBondCe: true,
        isEventLimited: false,
        craftType: "bond",
        flatBonus: def.flatBonus || 0,
        repeatable: false,
        isCustom: false,
        isGenericCraft: true,
        genericId: def.id,
      }));
    },
    genericParticipatingSet() {
      return new Set((this.genericParticipatingCraftIds || []).map(Number));
    },
    nonParticipatingCraftSet() {
      return new Set((this.nonParticipatingCraftIds || []).map(Number));
    },
    traitNameOptions() {
      return Object.keys(TRAIT_LABELS)
        .sort((a, b) => String(TRAIT_LABELS[a]).localeCompare(String(TRAIT_LABELS[b]), "zh"))
        .map((key) => ({ key, label: TRAIT_LABELS[key] }));
    },
    avatarMissingSet() {
      return new Set(this.avatarBroken.map(String));
    },
    servantMap() {
      const m = {};
      this.servants.forEach((s) => (m[s.id] = s));
      return m;
    },
    craftMap() {
      const m = {};
      this.allCrafts.forEach((c) => (m[c.id] = c));
      return m;
    },
    costUsed() {
      let total = 0;
      for (const slot of this.slots) {
        if (slot.isSupport) continue;
        if (slot.servantId !== null) total += this.servantCostOf(slot.servantId);
        const c = this.slotCraft(slot);
        if (c) total += c.cost || 0;
      }
      return total;
    },
    fixedCount() {
      return this.slots.filter((s) => s.servantId !== null && !s.isSupport).length;
    },
    supportCount() {
      return this.slots.filter((s) => s.isSupport).length;
    },
    freeCount() {
      return this.slots.filter((s) => !s.isSupport && s.servantId === null).length;
    },
    crownCount() {
      return this.mode === "crown" ? this.slots.filter((s) => s.isCrown).length : 0;
    },
    activeVerificationTokens() {
      return this.verificationMode === "full" ? this.verificationTokensFull : this.verificationTokens;
    },
    compareResults() {
      const wanted = this.compareSelectedRanks || [];
      return wanted.map((rank) => this.results.find((r) => r.rank === rank)).filter(Boolean);
    },
    overlayItems() {
      if (this.overlay.target === "servant") {
        const kw = this.overlay.keyword.toLowerCase();
        const isSupportSlot = this.overlay.slotIndex !== null && this.slots[this.overlay.slotIndex] && this.slots[this.overlay.slotIndex].isSupport;
        const crownGroup = this.mode === "crown" ? this.crownClass : "all";
        // 助战从者可选择所有已收录角色（不限于自己 Box）；
        // 简中模式下同样要排除简中服尚未实装的从者
        const source = isSupportSlot ? this.visibleServants : this.ownedServants;
        return this.sortServantList(
          source.filter((s) => {
            if (kw && !s.name.toLowerCase().includes(kw)) return false;
            if (!this.matchesClassFilter(s.class, this.overlay.classFilter)) return false;
            if (!this.matchesCrownClassFilter(s.class, crownGroup)) return false;
            if (this.overlay.rarityFilter !== "all" && Number(s.rarity) !== Number(this.overlay.rarityFilter)) return false;
            return true;
          }),
          this.overlay.sortBy,
          this.overlay.sortOrder
        );
      }
      // 礼装
      const kw = this.overlay.keyword.toLowerCase();
      if (this.overlay.craftType === "bond") {
        const isSupportSlot = this.overlay.slotIndex !== null && this.slots[this.overlay.slotIndex] && this.slots[this.overlay.slotIndex].isSupport;
        return this.meaningfulBondCrafts.filter((c) => {
          if (kw && !c.name.toLowerCase().includes(kw)) return false;
          // 迦勒底午茶时光等“助战加成礼装”只允许出现在助战位
          if (!isSupportSlot && Number(c.supportBonus || 0) > 0) return false;
          return true;
        });
      }
      // 其他礼装只显示 6 个抽象选项：无/1★~5★
      return this.otherCraftOptions.filter((c) => !kw || c.name.toLowerCase().includes(kw));
    },
    boxGridServants() {
      return this.filteredBoxServants().slice().sort((a, b) => b.collectionNo - a.collectionNo);
    },
    targetServantCandidates() {
      const kw = this.targetServantKeyword.trim().toLowerCase();
      return this.ownedServants
        .filter((s) => !kw || s.name.toLowerCase().includes(kw))
        .slice()
        .sort((a, b) => b.collectionNo - a.collectionNo);
    },
    eventBondEvents() {
      return (this.eventBondBonuses || [])
        .slice()
        .sort((a, b) => ((b.startedAt || 0) - (a.startedAt || 0)) || ((b.eventId || 0) - (a.eventId || 0)));
    },
    excludedServantSet() {
      return new Set(this.excludedServants.map(Number));
    },
    excludedCraftSet() {
      return new Set(this.excludedCrafts.map(Number));
    },
    cnUnavailableCraftSet() {
      return new Set((this.cnUnavailableCraftIds || []).map(Number));
    },
    filteredExclusionServants() {
      const kw = this.exclusionKeyword.trim().toLowerCase();
      return this.sortServantList(
        this.ownedServants.filter((s) => {
          if (kw && !s.name.toLowerCase().includes(kw)) return false;
          if (!this.matchesClassFilter(s.class, this.exclusionClass)) return false;
          if (this.exclusionRarity !== "all" && Number(s.rarity) !== Number(this.exclusionRarity)) return false;
          const b = this.box[s.id];
          if (this.exclusionMaxBond === "max" && !(b && b.maxBond)) return false;
          if (this.exclusionMaxBond === "notMax" && b && b.maxBond) return false;
          return true;
        }),
        this.exclusionSortBy,
        this.exclusionSortOrder
      );
    },
    filteredExclusionCrafts() {
      const kw = this.exclusionCraftKeyword.trim().toLowerCase();
      return this.meaningfulBondCrafts.filter((c) => !kw || c.name.toLowerCase().includes(kw));
    },
    simpleExcludedSet() {
      return new Set(this.simpleExcludedServants.map(Number));
    },
    filteredResults() {
      if (!this.simpleExcludedServants.length) return this.results;
      // ⚠️ 2026-10-16 修：不能只看本行头部那支队 —— 它的同分替补里可能还有干净的，
      // 那种行要留下（显示时自动换成干净的那支）；全被排除才整行藏掉。
      return this.results.filter((r) => this.rowSurvivesSimpleExclusion(r));
    },
    totalPages() {
      return Math.max(1, Math.ceil(this.filteredResults.length / this.pageSize));
    },
    pagedResults() {
      const start = (this.currentPage - 1) * this.pageSize;
      return this.filteredResults.slice(start, start + this.pageSize);
    },
  },
  async created() {
    // 系统原生下拉框（<select>）在 Electron 上偶发"弹不出来"→ 换成界面内浮层（见 installSelectShim）
    this.installSelectShim();
    try {
      const [info, servants, bondCrafts, allCrafts, customCrafts, userBox, presets, costumeNames, exclusions, accountInfo] = await Promise.all([
        window.fgo.getAppInfo(),
        window.fgo.listServants(),
        window.fgo.listBondCrafts(),
        window.fgo.listAllCrafts(),
        window.fgo.listCustomCrafts(),
        window.fgo.getUserBox(),
        window.fgo.listUserTeams(),
        window.fgo.getCostumeNames(),
        window.fgo.getExclusions(),
        window.fgo.listAccounts(),
      ]);
      this.info = info;
      this.accounts = (accountInfo && accountInfo.accounts) || [];
      this.activeAccountId = (accountInfo && accountInfo.activeId) || null;
      this.serverRegion = (info && info.serverRegion) || "jp";
      this.cnUnavailableCraftIds = (info && info.cnUnavailableBondCeIds) || [];
      this.cnUnavailableServantIds = (info && info.cnUnavailableServantIds) || [];
      this.genericParticipatingCraftIds = (info && info.genericParticipatingCraftIds) || [];
      this.nonParticipatingCraftIds = (info && info.nonParticipatingCraftIds) || [];
      this.costumeNames = costumeNames || {};
      this.excludedServants = (exclusions && exclusions.servants) || [];
      this.excludedCrafts = (exclusions && exclusions.crafts) || [];
      this.servants = servants;
      this.bondCrafts = bondCrafts;
      this.customCrafts = customCrafts || [];
      this.allCrafts = [...(allCrafts || []), ...(customCrafts || []).map((c) => this.customToCraft(c))];
      this.presets = presets || [];
      this.otherCrafts = (allCrafts || []).filter((c) => c.craftType === "other");

      this.applyBoxRows(userBox);

      try {
        const rawSettings = localStorage.getItem("fgoBondApp.resultSettings"); // platform-ok 纯 UI 偏好：Electron 与安卓 WebView 都支持 localStorage，且已 try/catch 兜底
        if (rawSettings) {
          this.resultSettings = Object.assign({}, this.resultSettings, JSON.parse(rawSettings));
        }
      } catch (_) {
        // 损坏的本地设置忽略即可
      }
      this.pageSize = Number(this.resultSettings.pageSize) || 50;

      window.fgo.onEngineProgress((data) => {
        const msg = data.message || "";
        if (this.updateRunning) {
          this.handleUpdateProgress(msg);
          return;
        }
        // 超级模式的机读进度：`[progress] [super] {"processed":…,"elapsed":…}`
        const m = /\[super\]\s*(\{.*\})\s*$/.exec(msg);
        if (m) {
          try {
            this.superProgress = JSON.parse(m[1]);
            return; // 这一行只喂进度条，不覆盖文字进度
          } catch (_) {
            // 解析失败就按普通进度文本处理
          }
        }
        this.progress = msg;
      });
      window.fgo.onMenuAction((data) => {
        // 窗口菜单栏「设置 → 计算设置 / 结果显示设置 / 诊断日志」会带 section 过来；
        // 不带（老路径）就打开全部分区。
        if (data && data.channel === "menu:settings") this.openSettings(data.section);
        // 帮助 → 使用说明（F1）/ 关于对话框里的「使用说明」→ 应用内打开，不再丢给记事本
        if (data && data.channel === "menu:manual") this.openManual();
        // 帮助 → 关于 → 「检查软件更新」：直接打开版本与更新信息并立刻查一次
        if (data && data.channel === "menu:version") {
          this.openVersionModal();
          if (!this.appUpdateChecking) this.checkAppUpdate();
        }
        if (data && data.channel === "menu:update-data") this.runUpdate();
        if (data && data.channel === "menu:reset-database") this.runDatabaseReset();
      });
    } catch (e) {
      this.error = e.message || String(e);
    } finally {
      this.loading = false;
    }
  },
  methods: {
    // ---------- 工具 ----------
    /** 某位从者这次要按多少 Cost 算：玛修可被玩家改成 0/16（其余一律取资料库） */
    servantCostOf(servantId) {
      const id = Number(servantId);
      const b = this.box && this.box[id];
      const ov = b ? b.costOverride : null;
      if (ov !== null && ov !== undefined && Number.isFinite(Number(ov))) return Number(ov);
      const s = this.servantMap[id];
      return s ? Number(s.cost || 0) : 0;
    },
    formatBondNumber(v) { return formatBondNumber(v); },
    // 千分位（「本次搜索」那行用；组合数动辄几万）
    formatCount(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      return n.toLocaleString("en-US");
    },
    persistResultSettings() {
      try {
        localStorage.setItem("fgoBondApp.resultSettings", JSON.stringify(this.resultSettings)); // platform-ok 纯 UI 偏好，各平台宿主都支持，见上
      } catch (_) {
        // 本地存储不可用时忽略
      }
      this.pageSize = Number(this.resultSettings.pageSize) || 50;
      this.currentPage = 1;
      if (!this.resultSettings.compareMode) this.compareSelectedRanks = [];
    },
    openSettings(section) {
      // 桌面：左上角「设置 ▾」下拉按分区打开（calc / display / diag）；
      // 安卓：没有系统菜单，工具栏「设置」按钮打开全部分区（section 不传 = all）。
      this.settingsSection = typeof section === "string" && section ? section : "all";
      this.settingsMenuOpen = false;
      this.settingsVisible = true;
    },
    closeSettings() {
      this.persistResultSettings();
      this.settingsVisible = false;
      this.settingsSection = "all";
    },
    openManual() {
      // 应用内阅读（替代原来的"用记事本打开 使用说明.txt"）
      this.manualVisible = true;
      this.manualActive = 0;
      this.$nextTick(() => {
        const box = this.$refs.manualContent;
        if (box) box.scrollTop = 0;
      });
    },
    closeManual() {
      this.manualVisible = false;
    },
    gotoManualSection(index) {
      this.manualActive = index;
      const box = this.$refs.manualContent;
      if (!box) return;
      const target = box.querySelector(`[data-sec="${index}"]`);
      if (target) box.scrollTop = target.offsetTop - box.offsetTop;
    },
    /** 手册正文的行内标记渲染（模板里用 v-html，内容已转义，只保留自己的 <b>） */
    manualInlineHtml(text) {
      return manualInlineHtml(text);
    },
    resultBonusFormula(member) {
      if (!member || member.isSupport || !member.bonusDetail) return "";
      const d = member.bonusDetail;
      const pct = (v) => `${(Number(v || 0) * 100).toFixed(1).replace(/\.0$/, "")}%`;
      const inner = [
        d.universalCraftBonus,
        d.supportCraftBonus,
        d.traitCraftBonus,
        d.maxBondBonus,
        d.activityBonus,
        d.auraBonus,
        d.personalBonus,
      ].filter((v) => Number(v || 0) > 0).map(pct).join(" + ") || "0%";
      const front = Number(d.frontlineBonus || 0) > 0 ? pct(d.frontlineBonus) : "0%";
      return `(1 + ${front}) × (1 + ${inner}) = x${Number(d.totalMultiplier || 0).toFixed(4)}`;
    },
    craftCostById(craftId) {
      if (craftId === null || craftId === undefined) return 0;
      const craft = this.craftById(craftId);
      if (craft) return Number(craft.cost || 0);
      const fallback = { 0: 0, "-1": 1, "-2": 3, "-3": 5, "-4": 9, "-5": 12, "-10": 12, "-20": 5, "-21": 9, "-22": 9 };
      return Number(fallback[String(Number(craftId))] || 0);
    },
    resultCostBreakdown(member) {
      if (!member || member.isSupport) return "";
      const servantCost = this.servantCostOf(member.servantId);
      const mainCost = this.craftCostById(member.craftId);
      const secondCost = this.craftCostById(member.secondCraftId);
      const total = servantCost + mainCost;
      const secondText = secondCost ? ` + 第二礼装 ${secondCost}` : (member.secondCraftId ? " + 第二礼装 0" : "");
      return `从者 ${servantCost} + 主礼装 ${mainCost}${secondText} = ${total}`;
    },
    /**
     * 这一行「当前显示」的队伍用掉的 Cost。
     *
     * 2026-10-21 修（评论区反馈）：行头 / 详情 / 对比表原来一律写 `r.costUsed`，那是**引擎给的那一支**
     * 的 Cost；在同分下拉里换了一支（从者不同 ⇒ 从者 Cost 不同）后，屏幕上人员变了、Cost 却纹丝不动。
     * 实测（`.temp/probe-samescore-cost.py`，11 行的样本里有 4 行）：同一行的同分替补 Cost 会差 3~5
     * （例：#2 的 96 支落在 106 / 107 / 110，#5 的 64 支落在 105 / 110）。
     *
     * 口径必须与引擎 `calculator.py::team_cost` 完全一致：
     *   只算玩家位（**助战不计 Cost**），每位 = 从者 Cost + 主礼装 Cost，
     *   冠位第二礼装位按 0 计。
     * 没换队（`displayedResultTeam` 原样返回同一数组）时**直接返回引擎的值**，
     * 免得客户端兜底表与引擎在边角上算出不同数字。
     */
    resultCostUsed(result) {
      const raw = (result && result.team) || [];
      const team = this.displayedResultTeam(result);
      if (!Array.isArray(team) || !team.length || team === raw) {
        return Number((result && result.costUsed) || 0);
      }
      let total = 0;
      for (const m of team) {
        if (!m || m.isSupport) continue;
        total += this.servantCostOf(m.servantId);
        total += this.craftCostById(m.craftId);
      }
      return total;
    },
    // ---------------- 同分替补的个体数值重算（2026-10-22）----------------
    // 引擎只对**本行原来那一支**算过每人的加成明细/个人倍率/牵绊；同分替补只带 id。
    // 所以这里按引擎同一条公式重算（纯函数在 renderer/bond-math.js）：
    //   · 每人取**自己的最优形态**（在本队这套礼装下特性收益最大；平手优先本体、取更高阶段；
    //     本体达不到才用灵衣）——这正是同分判定所用的口径，所以换上来的人分数必然相同；
    //   · 队伍级的三项（通用/助战/活动）直接取本行引擎值 —— 同分替补礼装多重集相同，这三项不变；
    //   · 满绊人数按界面同一套标记重算（含「视为非满绊」开关）。
    /** 取/加载某从者的形态特性（每形态一组特性；库外不变） */
    async ensureServantForms(ids) {
      const region = (this.info && this.info.serverRegion) || "jp";
      const list = Array.from(new Set((ids || []).map(Number).filter((sid) => sid > 0)));
      const todo = list.filter((sid) => !(this.servantForms || {})[sid] && !(this.servantFormsLoading || {})[sid]);
      if (!todo.length) return;
      const loading = { ...(this.servantFormsLoading || {}) };
      todo.forEach((sid) => (loading[sid] = true));
      this.servantFormsLoading = loading; // 同步占位，避免连续渲染重复请求
      try {
        for (const sid of todo) {
          const forms = {};
          const asc = (await window.fgo.getAllStageTraits(sid, region)) || {};
          Object.keys(asc).forEach((k) => {
            forms[k] = asc[k];
          });
          const costumes = ((this.servantMap[sid] || {}).costumes || []).map(Number);
          for (const cid of costumes) {
            const key = `costume_${cid}`;
            const traits = (await window.fgo.getStageTraits(sid, key, region)) || [];
            // 库里这件灵衣是空集 ⇒ Atlas 表示"不改特性" ⇒ 用本体（与采集代码修好后的口径一致）
            forms[key] = traits.length ? traits : asc.fourth || asc.third || [];
          }
          this.servantForms = { ...(this.servantForms || {}), [sid]: forms };
        }
      } catch (err) {
        try {
          // 渲染层没有独立的诊断接口：console 会被主进程捕获进诊断日志（见 main/ipc-handlers.js）
          console.warn(`同分替补形态数据取失败：${(err && err.message) || err}`);
        } catch (_) {
          /* 日志本身不能抛 */
        }
      } finally {
        const rest = { ...(this.servantFormsLoading || {}) };
        todo.forEach((sid) => delete rest[sid]);
        this.servantFormsLoading = rest;
      }
    },
    /** 本队"有效礼装"（与引擎 `_effect_crafts` 同口径）：玩家位 + 可计入的助战礼装 */
    teamEffectCrafts(alt) {
      const crafts = [];
      const push = (cid) => {
        const c = this.craftById(cid);
        if (c) crafts.push(c);
      };
      ((alt && alt.craftIds) || []).forEach(push);
      ((alt && alt.secondCraftIds) || []).forEach(push);
      [alt && alt.supportCraftId, alt && alt.supportSecondCraftId].forEach((cid) => {
        const c = this.craftById(cid);
        // 只有"不带独立助战加成"的牵绊礼装才并入普通加成（引擎同口径）
        const n = c && typeof BondMath !== "undefined" ? BondMath.normCraft(c) : null;
        if (n && n.isBond && n.supportBonus <= 0) crafts.push(c);
      });
      return crafts;
    },
    /** 队伍级上下文：同分替补共用（通用/助战两项按这一支自己的礼装算，活动加成沿用本行） */
    teamBonusContext(result, alt, displayedTeam) {
      const firstPlayer = (displayedTeam || []).find((m) => !m.isSupport) || {};
      const d = firstPlayer.bonusDetail || {};
      const effectCrafts = this.teamEffectCrafts(alt);
      const act = (cid, field) => {
        const c = this.craftById(cid);
        if (!c || typeof BondMath === "undefined") return 0;
        return field === "support" ? BondMath.supportCraftBonus(c) : 0;
      };
      const support = act(alt && alt.supportCraftId, "support") + act(alt && alt.supportSecondCraftId, "support");
      const universal = typeof BondMath === "undefined" ? 0 : BondMath.universalBonus(effectCrafts);
      let maxBondCount = 0;
      (displayedTeam || []).forEach((m) => {
        if (!m || m.isSupport) return;
        const f = this.bondFlagsFor((this.box && this.box[m.servantId]) || {});
        if (f.maxBond && f.switch1) maxBondCount += 1;
      });
      return {
        effectCrafts,
        traitCrafts: effectCrafts.filter((c) => (c.bonusType || c.bonus_type) === "trait"),
        universal,
        support,
        activity: Number(d.activityBonus || 0),
        maxBondCount,
        baseBond: Number((result && result.baseBond) || 0),
      };
    },
    /**
     * 重算一位"被换上来"的成员。返回 `{ detail, stage }`；形态数据还没取到就返回 null
     * （调用方保留引擎原值，等 `ensureServantForms` 回来后自动补上）。
     */
    recomputeMemberBonus(member, ctxInfo) {
      if (typeof BondMath === "undefined" || !member || member.isSupport) return null;
      const sid = Number(member.servantId);
      const forms = (this.servantForms || {})[sid];
      if (!forms || !Object.keys(forms).length) return null;
      const form = BondMath.bestForm(forms, ctxInfo.traitCrafts) || member.stage || "fourth";
      const traits = new Set(forms[form] || []);
      const trait = BondMath.traitBonus(traits, ctxInfo.traitCrafts);
      const flat = BondMath.flatBonus(traits, ctxInfo.effectCrafts);
      const b = (this.box && this.box[sid]) || {};
      const flags = this.bondFlagsFor(b);
      const frontline = BondMath.frontlineBonus(member.position);
      const maxBondBonus = 0.25 * Number(ctxInfo.maxBondCount || 0);
      // ⚠️ Box 里存的是**百分数**（界面上写「20%」就是 20），而 bonusDetail 与 BondMath 一律用**小数**（0.2）。
      // 这里漏了 /100 会让「同分替补换上来的人」显示成 21.00x（2026-10-25 用户报的预设就是这一条）。
      const aura = Number(b.auraBonus || 0) / 100;
      const personal = Number(b.personalBonus || 0) / 100;
      let multiplier = BondMath.memberMultiplier({
        frontline,
        universal: ctxInfo.universal,
        support: ctxInfo.support,
        trait,
        maxBond: maxBondBonus,
        activity: ctxInfo.activity,
        aura,
        personal,
      });
      // 满绊但没开「自身参与收益」⇒ 该位倍率记 0（引擎原样）
      if (flags.maxBond && !flags.switch2) multiplier = 0;
      return {
        stage: form,
        detail: {
          frontlineBonus: frontline,
          universalCraftBonus: ctxInfo.universal,
          supportCraftBonus: ctxInfo.support,
          traitCraftBonus: trait,
          flatCraftBonus: flat,
          maxBondBonus,
          activityBonus: ctxInfo.activity,
          auraBonus: aura,
          personalBonus: personal,
          totalMultiplier: multiplier,
          bondPoints: BondMath.bondPoints(multiplier, ctxInfo.baseBond, flat),
          recomputed: true,
        },
      };
    },
    qualityModeText(mode) {
      const map = { fast: "快速", standard: "标准", balanced: "平衡", high: "高质量", extreme: "极限精算" };
      return map[mode] || mode || "";
    },
    /**
     * 档位 → 时间预算（毫秒）。**唯一来源**：以前这份表在 buildPayload / buildPresetPayload
     * 各抄了一份，加档位时容易改漏一处。
     * 预算只决定"引擎的计划量 + 等待上限"：计划算完就返回，不会等满。
     */
    timeoutForQuality(mode) {
      const map = { fast: 35000, standard: 60000, balanced: 90000, high: 135000, extreme: 300000 };
      return map[mode] || map.balanced;
    },
    strategyText(strategy) {
      const map = { total_max: "总牵绊最大化", target_max: "指定从者最大化", balanced: "均衡模式" };
      return map[strategy] || strategy || "总牵绊最大化";
    },
    // ---------------- 简易排除（只影响显示：把含被排除从者的队伍藏起来）----------------
    /** 这一组成员里有没有被简易排除的从者 */
    hitSimpleExclusion(servantIds) {
      if (!this.simpleExcludedServants.length) return false;
      const ex = this.simpleExcludedSet;
      return (servantIds || []).some((sid) => ex.has(Number(sid)));
    },
    /**
     * 同分替补里**过滤掉含被排除从者**的那些（模板与显示都用它）。
     * ⚠️ 引擎返回的原列表见 sameScoreList()，反馈摘要/导出仍用原列表。
     */
    sameScoreListFiltered(result) {
      const list = this.sameScoreList(result);
      if (!this.simpleExcludedServants.length) return list;
      return list.filter((a) => !this.hitSimpleExclusion(a.servantIds));
    },
    /** 被简易排除藏起来的替补条数（给提示用） */
    sameScoreHiddenCount(result) {
      return this.sameScoreList(result).length - this.sameScoreListFiltered(result).length;
    },
    /**
     * 这一行还该不该显示（2026-10-16 修）：
     * 本行自己没被排除 ⇒ 显示；本行被排除、但**同分替补里还有干净的** ⇒ 也显示
     * （显示时自动换成那支干净的，见 displayedResultTeam）；一支都不剩才整行藏掉。
     */
    rowSurvivesSimpleExclusion(result) {
      if (!this.simpleExcludedServants.length) return true;
      if (!this.hitSimpleExclusion((result.team || []).map((m) => m.servantId))) return true;
      return this.sameScoreListFiltered(result).length > 0;
    },
    // ---------------- 同分可替换阵容（引擎 sameScoreTeams；旧引擎没这个字段 → 全部退化为空）----------------
    sameScoreList(result) {
      const list = result && Array.isArray(result.sameScoreTeams) ? result.sameScoreTeams : [];
      return list.filter((a) => a && Array.isArray(a.servantIds));
    },
    sameScoreCount(result) {
      return this.sameScoreListFiltered(result).length;
    },
    /** 当前选中项在**过滤后**列表里的下标（下拉 v-for 用的就是过滤后的列表） */
    sameScoreChoiceIndex(result) {
      const raw = this.sameScoreList(result);
      const list = this.sameScoreListFiltered(result);
      const want = Number((this.sameScoreChoice || {})[Number(result && result.rank)]);
      const rawIdx = Number.isInteger(want) && want >= 0 && want < raw.length ? want : 0;
      const idx = list.indexOf(raw[rawIdx]);
      return idx >= 0 ? idx : 0;
    },
    chooseSameScore(result, index) {
      const rank = Number(result && result.rank);
      if (!rank) return;
      // 模板传进来的是"过滤后列表"的下标 ⇒ 存回原列表下标（否则一排除就从 0 重算）
      const alt = this.sameScoreListFiltered(result)[index];
      const rawIdx = alt ? this.sameScoreList(result).indexOf(alt) : 0;
      this.sameScoreChoice = { ...(this.sameScoreChoice || {}), [rank]: rawIdx >= 0 ? rawIdx : 0 };
    },
    /**
     * 一条同分阵容**可直接渲染**的清单：`[{ position, servantId, craftId, secondCraftId, changed }]`。
     *
     * 数据来源有两种（引擎新结构 / 0.2.4 及更早的平行数组），这里统一成"位置 → 配置"的映射，
     * 再按**显示口径**落位：
     *   · 本行留下的人坐回自己的位子，空出来的位子才给换上来的人
     *     （同侧内部次序不影响分数 —— 同分去重键本来就是"前排是谁、后排是谁"的集合）；
     *   · 顺序＝先前排后后排，各段"换掉的在前、没换的在后"。
     *
     * 为什么界面还要再排一次：`changed` 当初是**相对某一行的 head** 算出来的，而合并同分行时
     * 别的行的替补会被并进来（新引擎已按 head 重算，见 search.py::_rebase_alt）；
     * 更早存下的结果里带的是旧口径 —— 这里按映射重算一遍就自动纠正，不必让用户重算。
     * 重算只依赖映射本身，不需要"猜谁换了"。
     */
    altSlots(result, alt) {
      const players = ((result && result.team) || []).filter((m) => !m.isSupport);
      const ids = (alt && alt.servantIds) || [];
      const positions = alt && alt.positions;
      const crafts = (alt && alt.craftIds) || [];
      const seconds = (alt && alt.secondCraftIds) || [];
      // ① 位置 → 这一支的配置
      const map = {};
      if (Array.isArray(positions) && positions.length === ids.length && ids.length) {
        positions.forEach((pos, i) => {
          map[String(pos)] = {
            servantId: Number(ids[i]),
            craftId: crafts[i],
            secondCraftId: seconds[i],
          };
        });
      } else {
        // 旧结构：平行数组就是按本行位置次序给的
        players.forEach((m, i) => {
          map[String(m.position)] = {
            servantId: ids[i] !== undefined ? Number(ids[i]) : Number(m.servantId),
            craftId: crafts[i] !== undefined ? crafts[i] : m.craftId,
            secondCraftId: seconds[i] !== undefined ? seconds[i] : m.secondCraftId,
          };
        });
      }
      // ② 每侧落位：存活者复位、新人填空位
      const seatSide = (side) => {
        const avail = side.map((m) => map[String(m.position)]).filter(Boolean).slice();
        const seated = {};
        const empty = [];
        side.forEach((m) => {
          const want = Number(m.servantId);
          const hit = avail.findIndex((s) => s.servantId === want);
          if (hit >= 0) {
            seated[m.position] = { ...avail.splice(hit, 1)[0], changed: false };
          } else {
            empty.push(m.position);
          }
        });
        empty.forEach((pos) => {
          const s = avail.shift();
          if (s) seated[pos] = { ...s, changed: true };
        });
        return side
          .filter((m) => seated[m.position])
          .map((m) => ({ position: String(m.position), ...seated[m.position] }));
      };
      const isFront = (p) => String(p || "").startsWith("front");
      const front = seatSide(players.filter((m) => isFront(m.position)));
      const back = seatSide(players.filter((m) => !isFront(m.position)));
      const ordered = (list) => list.filter((s) => s.changed).concat(list.filter((s) => !s.changed));
      return ordered(front).concat(ordered(back));
    },
    // 下拉里一条成员：从者 + 礼装都取自**这一条自己**（合并同分行后，不同条的礼装可能不一样）
    sameScoreMember(result, slot) {
      if (!slot) return null;
      const base = ((result && result.team) || [])
        .filter((m) => !m.isSupport)
        .find((m) => String(m.position) === String(slot.position)) || {};
      const craft = this.craftById(slot.craftId);
      const secondCraft = this.craftById(slot.secondCraftId);
      return {
        position: slot.position,
        posLabel: this.positionLabel(slot.position),
        servantId: slot.servantId,
        // 这一位跟本行相比是不是换了人（界面用它把换掉的头像描个橙边，一眼看到差异）
        changed: !!slot.changed,
        name: this.resultMemberName({ ...base, servantId: slot.servantId }),
        craftId: slot.craftId,
        secondCraftId: slot.secondCraftId,
        craftName: (craft && craft.name) || "",
        secondCraftName: (secondCraft && secondCraft.name) || "",
      };
    },
    // 下拉里每一支按"前排 / 后排"分组（界面用头像展示，名字与礼装放悬浮提示）。
    // 顺序直接用 `altSlots` 给的（引擎已排好：各段换掉的在前），不再在这里排序。
    sameScoreRows(result, alt) {
      const slots = this.altSlots(result, alt);
      const isFront = (p) => String(p || "").startsWith("front");
      const front = slots.filter((s) => isFront(s.position)).map((s) => this.sameScoreMember(result, s));
      const back = slots.filter((s) => !isFront(s.position)).map((s) => this.sameScoreMember(result, s));
      const rows = [];
      if (front.length) rows.push({ label: "前排", members: front });
      if (back.length) rows.push({ label: "后排", members: back });
      return rows;
    },
    // 把某一支同分阵容渲染成"前排：… ｜ 后排：…"（文字版，反馈摘要用；带各自礼装）
    sameScoreTeamText(result, alt) {
      const slots = this.altSlots(result, alt);
      const isFront = (p) => String(p || "").startsWith("front");
      const text = (s) => {
        const e = this.sameScoreMember(result, s);
        const crafts = [e.craftName, e.secondCraftName].filter(Boolean).join(" + ");
        return crafts ? `${e.name}（${crafts}）` : e.name;
      };
      const front = slots.filter((s) => isFront(s.position)).map(text);
      const back = slots.filter((s) => !isFront(s.position)).map(text);
      const parts = [];
      if (front.length) parts.push(`前排：${front.join("、")}`);
      if (back.length) parts.push(`后排：${back.join("、")}`);
      const sup = ((result && result.team) || []).find((m) => m.isSupport);
      const sCid = alt && alt.supportCraftId !== undefined ? alt.supportCraftId : (sup || {}).craftId;
      const sName = (this.craftById(sCid) || {}).name;
      if (sName) parts.push(`助战礼装：${sName}`);
      return parts.join(" ｜ ");
    },
    // ---------------- 同分下拉的排序与分节（2026-10-22 用户定口径）----------------
    // 为什么要排：引擎给的顺序是 `itertools.product` 的（最后一位变化最快，
    // 96 支里"只换 1 个人"的只有 8 支，会被整片埋掉）。
    // 排序键（从优先到次要）：
    //   ① 与本行差几个人（升序）—— 本行恒为 0，所以天然排第一；
    //   ② 只动后排 > 只动前排 > 前后都动 —— 玩家最愿意动的是替补席，
    //      前排有 +20% 先发加成、动了等于换主力；
    //   ③ **换掉的是谁**（升序，见下）—— 段内先按"被替换者"成组，
    //      读起来就是「把 A 换成 B/C/D」，而不是"换的人一直在跳"；
    //   ④ 换**进来**的从者图鉴号（升序）—— 组内保持稳定；
    //   ⑤ 原列表下标（兜底，保证同一份结果每次打开顺序完全一样）。
    // 不参与排序的：Cost（同分队伍的 Cost 差异没有"更好"的语义，只是硬约束）、
    // 稀有度/职阶（与"只算牵绊"这个目标无关）。
    // 口径：改动数用**前排集合 Δ + 后排集合 Δ**，不用位置序号 ——
    // 同分组的去重键本来就是"前排是谁、后排是谁"，按位置算会把"前排内部换位"误记成改动。
    sameScoreDelta(result, alt) {
      const head = ((result && result.team) || []).filter((m) => !m.isSupport);
      const slots = this.altSlots(result, alt);
      const isFront = (p) => String(p || "").startsWith("front");
      const idsOf = (list, front) => new Set(
        list.filter((x) => (front === null ? true : isFront(x.position) === front)).map((x) => Number(x.servantId)),
      );
      const hFront = idsOf(head, true);
      const hBack = idsOf(head, false);
      const aFront = idsOf(slots, true);
      const aBack = idsOf(slots, false);
      const outFront = [...hFront].filter((sid) => !aFront.has(sid));
      const outBack = [...hBack].filter((sid) => !aBack.has(sid));
      const changed = outFront.length + outBack.length;
      // 0 = 只动后排｜1 = 只动前排｜2 = 前后都动（changed 为 0 时按 0 排，反正它排最前）
      const side = outFront.length === 0 ? 0 : (outBack.length === 0 ? 1 : 2);
      const dexOf = (sid) => Number((this.servantMap[sid] || {}).collectionNo || 999999);
      // ③ 被换掉的人（图鉴号升序）—— "差 1 人"时就是"把这个人换成谁"的那一组
      const goneIds = [...outFront, ...outBack].sort((a, b) => dexOf(a) - dexOf(b));
      const gone = goneIds.map(dexOf);
      const incoming = [...aFront, ...aBack].filter((sid) => !hFront.has(sid) && !hBack.has(sid));
      const inIds = incoming.slice().sort((a, b) => dexOf(a) - dexOf(b));
      const dex = inIds.map(dexOf);
      return { changed, side, gone, goneIds, dex };
    },
    /** 排好序的同分替补：`[{ alt, index, delta }]`，index 是**过滤后列表**的下标 */
    sameScoreSorted(result) {
      const list = this.sameScoreListFiltered(result);
      const rows = list.map((alt, index) => ({ alt, index, delta: this.sameScoreDelta(result, alt) }));
      rows.sort((a, b) => {
        if (a.delta.changed !== b.delta.changed) return a.delta.changed - b.delta.changed;
        if (a.delta.side !== b.delta.side) return a.delta.side - b.delta.side;
        // ③ 换掉的是谁 → ④ 换进来的是谁 → ⑤ 原下标（三段都是"逐位比数组"）
        for (const key of ["gone", "dex"]) {
          const da = a.delta[key] || [];
          const db = b.delta[key] || [];
          for (let i = 0; i < Math.max(da.length, db.length); i += 1) {
            const x = i < da.length ? da[i] : -1;
            const y = i < db.length ? db[i] : -1;
            if (x !== y) return x - y;
          }
        }
        return a.index - b.index;
      });
      return rows;
    },
    sameScoreSectionLabel(changed, side, total) {
      const who = changed === 0
        ? "本行原阵容"
        : `差 ${changed} 人 · ${side === 0 ? "只动后排" : (side === 1 ? "只动前排" : "前后都动")}`;
      return `${who} · ${total} 支`;
    },
    /** 折叠阈值：超过这么多支就先只显示前 20 支（一屏之内） */
    sameScoreCollapseLimit() {
      return 20;
    },
    /**
     * 模板用的分节结果：`[{ key, label, items: [{ alt, index, delta }] }]`。
     * 默认折叠到 20 支；展开状态按 rank 记（`sameScoreExpanded`）。
     */
    sameScoreSections(result) {
      const rank = Number(result && result.rank);
      const expanded = !!(this.sameScoreExpanded || {})[rank];
      const budget0 = expanded ? Infinity : this.sameScoreCollapseLimit();
      const grouped = [];
      this.sameScoreSorted(result).forEach((row) => {
        const key = `${row.delta.changed}:${row.delta.side}`;
        const last = grouped[grouped.length - 1];
        if (last && last.key === key) last.items.push(row);
        else grouped.push({ key, changed: row.delta.changed, side: row.delta.side, items: [row] });
      });
      const out = [];
      let budget = budget0;
      for (const sec of grouped) {
        if (budget <= 0) break;
        const items = sec.items.slice(0, budget);
        budget -= items.length;
        // 组内标记："换掉的是谁"变了就插一条小标题（只在真的会换人时）
        let lastGone = null;
        items.forEach((it) => {
          if (it.delta.changed > 0) {
            const gk = (it.delta.gone || []).join(",");
            if (gk !== lastGone) {
              const names = (it.delta.goneIds || []).map((sid) => {
                const s = this.servantMap[sid];
                return (s && s.name) || `#${sid}`;
              });
              it.subLabel = `换掉 ${names.join("、") || "—"}`;
              lastGone = gk;
            }
          }
        });
        out.push({
          key: sec.key,
          label: this.sameScoreSectionLabel(sec.changed, sec.side, sec.items.length),
          items,
          total: sec.items.length,
        });
      }
      return out;
    },
    /** 被折叠起来的支数（0 = 已经全列出来了） */
    sameScoreCollapsedCount(result) {
      const shown = this.sameScoreSections(result).reduce((n, sec) => n + sec.items.length, 0);
      return Math.max(0, this.sameScoreCount(result) - shown);
    },
    sameScoreExpandable(result) {
      return this.sameScoreCount(result) > this.sameScoreCollapseLimit();
    },
    toggleSameScoreExpand(result) {
      const rank = Number(result && result.rank);
      if (!rank) return;
      const cur = !!(this.sameScoreExpanded || {})[rank];
      this.sameScoreExpanded = { ...(this.sameScoreExpanded || {}), [rank]: !cur };
    },
    /**
     * 把一行里的某个成员换成「这一支」的从者 / 礼装，并把**按 id 显示的字面量**一起刷新。
     *
     * ⚠️ 引擎在成员里直接带了 name / craftName / secondCraftName（都是**本行原来那一支**的），
     * 换队时只改 id 不改这几个字段 ⇒ 详情表里会"换成新人却还写着旧名字"、
     * 礼装格"新礼装的图 + 旧礼装的名字"（2026-10-21 修 Cost 时一并查出）。
     * 名字这类**纯展示**字段客户端能自己查库补，所以这里按 id 重取；
     * 而 bonusDetail / traitHits 这类**算出来的**字段客户端算不出来，只能保持原样
     * （同分替补由恒等式展开、数值本与本题相同，见 search 模块那段注释）。
     */
    displayedMemberWithSlot(m, servantId, craftId, secondCraftId) {
      const next = { ...m, servantId, craftId, secondCraftId };
      const s = this.servantMap[servantId];
      if (s && s.name) next.name = s.name;
      if (craftId !== m.craftId) {
        const c = this.craftById(craftId);
        next.craftName = c ? (c.name || "") : "";
        if (c && c.craftType) next.craftType = c.craftType;
      }
      if (secondCraftId !== m.secondCraftId) {
        const c2 = this.craftById(secondCraftId);
        next.secondCraftName = c2 ? (c2.name || "") : "";
        if (c2 && c2.craftType) next.secondCraftType = c2.craftType;
      }
      return next;
    },
    // 这一行"当前显示"的队伍：若在同分下拉里选了某一支，就把**整支配置**换掉
    // （从者 + 每个位置的礼装 + 助战礼装；位置本身由方案决定，不变）
    displayedResultTeam(result) {
      const team = (result && result.team) || [];
      // 用**过滤后**的替补列表：本行头部被简易排除时，这里会自动换成第一支干净的
      const list = this.sameScoreListFiltered(result);
      if (!list.length) return team;
      const alt = list[this.sameScoreChoiceIndex(result)] || {};
      const slots = this.altSlots(result, alt);
      const players = team.filter((m) => !m.isSupport);
      if (!slots.length || players.length !== slots.length) return team;
      // 选中的这支和本行原本那支是同一套从者（顺序可能不同）⇒ 原样返回（别把礼装也换掉）
      const altIds = slots.map((s) => Number(s.servantId));
      if (players.every((m) => altIds.indexOf(Number(m.servantId)) >= 0)) return team;
      // 按**位置**取这一支的配置（引擎已经把 positions 给出来了，不再靠下标猜）
      const byPos = {};
      slots.forEach((s) => {
        byPos[String(s.position)] = s;
      });
      const swapped = team.map((m) => {
        if (m.isSupport) {
          return this.displayedMemberWithSlot(
            m,
            m.servantId,
            alt.supportCraftId !== undefined ? alt.supportCraftId : m.craftId,
            alt.supportSecondCraftId !== undefined ? alt.supportSecondCraftId : m.secondCraftId,
          );
        }
        const slot = byPos[String(m.position)] || {};
        return this.displayedMemberWithSlot(
          m,
          slot.servantId !== undefined ? slot.servantId : m.servantId,
          slot.craftId !== undefined ? slot.craftId : m.craftId,
          slot.secondCraftId !== undefined ? slot.secondCraftId : m.secondCraftId,
        );
      });

      // 被换上来的人：引擎没给过他们的个体数值 ⇒ 按"自己的最优形态"重算一遍
      // （公式与判据见 renderer/bond-math.js；队伍级的三项沿用本行引擎值）
      const ctxInfo = this.teamBonusContext(result, alt, swapped);
      const need = [];
      const out = swapped.map((m) => {
        if (m.isSupport) return m;
        const slot = byPos[String(m.position)] || {};
        if (!slot.changed) return m;
        need.push(Number(m.servantId));
        const bonus = this.recomputeMemberBonus(m, ctxInfo);
        if (!bonus) return m;
        return { ...m, stage: bonus.stage, bonusDetail: { ...(m.bonusDetail || {}), ...bonus.detail } };
      });
      // 形态数据还没取到 ⇒ 后台取回来（取到后界面自动重算，不是每帧都请求）
      if (need.some((sid) => !(this.servantForms || {})[sid])) this.ensureServantForms(need);
      return out;
    },
    sameScoreActive(result) {
      return this.sameScoreListFiltered(result).length > 1 && this.sameScoreChoiceIndex(result) > 0;
    },
    visibleResultTeam(result) {
      const team = this.displayedResultTeam(result);
      if (!this.resultSettings.hideSupport) return team;
      return team.filter((m) => !m.isSupport);
    },
    visibleResultCraftItems(member) {
      const items = this.resultCraftItems(member);
      if (!this.resultSettings.hideEmptyCraftSlots) return items;
      return items.filter((cm) => cm.craftId !== null && cm.craftId !== undefined && Number(cm.craftId) !== 0);
    },
    craftHitMembers(result, craftId) {
      const team = (result && result.team) || [];
      if (!team.some((m) => Array.isArray(m.traitHits))) return "—（旧引擎结果无此数据）";
      const target = Number(craftId);
      const hits = [];
      for (const m of team) {
        if (m.isSupport) continue;
        const memberHits = (m.traitHits || []).filter((h) => Number(h.craftId) === target);
        if (!memberHits.length) continue;
        const name = m.name || (this.servantMap[m.servantId] ? this.servantMap[m.servantId].name : "") || m.servantId;
        const conditions = [];
        memberHits.forEach((h) => {
          (h.groups || []).forEach((g) => {
            const text = (g || []).map((t) => this.traitLabel(t)).join(" + ");
            if (text && !conditions.includes(text)) conditions.push(text);
          });
        });
        hits.push(`${name}${conditions.length ? `（${conditions.join(" 或 ")}）` : ""}`);
      }
      return hits.join("、") || "未命中任何成员";
    },
    resultMemberName(member) {
      if (!member) return "";
      const s = this.servantMap[member.servantId];
      return member.name || (s ? s.name : "") || member.servantId;
    },
    resultBondInfo(member) {
      if (!member || member.isSupport) return null;
      const s = this.servantMap[member.servantId];
      return s ? this.servantBondInfo(s) : null;
    },
    memberCraftsText(member) {
      return this.resultCraftItems(member)
        .map((cm) => cm.craftName || "无礼装")
        .filter(Boolean)
        .join(" + ") || "无礼装";
    },
    traitCoverageText(result) {
      return ((result && result.traitCoverage) || []).map((t) => this.traitLabel(t)).join("、");
    },
    craftBonusDetailText(d) {
      if (!d) return "";
      const typeLabel = { universal: "通用", trait: "特性", support: "助战", flat: "固定" }[d.type] || "礼装";
      const name = d.craftName ? `「${d.craftName}」` : "";
      const value = d.type === "flat"
        ? `+${this.formatBondNumber(d.value)}`
        : `+${(Number(d.value || 0) * 100).toFixed(1).replace(/\.0$/, "")}%`;
      const groups = (d.groups || [])
        .map((g) => (g || []).map((t) => this.traitLabel(t)).join(" + "))
        .filter(Boolean);
      const cond = groups.length ? `（条件：${groups.join(" 或 ")}）` : "";
      return `${typeLabel}${name}：${value}${cond}`;
    },
    toggleCompareResult(result) {
      const rank = Number(result.rank);
      const idx = this.compareSelectedRanks.indexOf(rank);
      if (idx >= 0) this.compareSelectedRanks.splice(idx, 1);
      else this.compareSelectedRanks.push(rank);
    },
    openCompare() {
      if (this.compareResults.length >= 2) this.compareVisible = true;
    },
    closeCompare() {
      this.compareVisible = false;
    },
    async copyFeedbackSummary() {
      const selected = this.compareResults;
      if (!selected.length) {
        alert("请先在方案卡片上勾选要包含的方案（可多选）");
        return;
      }
      const full = this.resultSettings.feedbackMode === "full";
      const lines = [];
      lines.push(`FGO牵绊推荐器反馈摘要 v${this.info && this.info.version ? this.info.version : "?"}`);
      lines.push(`服务器：${this.serverRegion === "cn" ? "简中服" : "日服"}｜模式：${this.mode === "crown" ? `戴冠战(${this.crownClass})` : "普通"}｜策略：${this.strategyText(this.strategy)}`);
      lines.push(`Cost上限：${this.costLimit}｜计算档位：${this.qualityModeText(this.qualityMode)}｜包含方案：${selected.map((r) => `#${r.rank}`).join("、")}`);
      if (this.info && (this.info.dataUpdatedAt || this.info.dataRegion)) {
        lines.push(`数据版本：${this.info.dataUpdatedAt || "未知"}｜数据区：${this.info.dataRegion || "JP"}`);
      }
      if (this.lastSearchStats) {
        lines.push(`搜索：用时 ${this.lastSearchStats.elapsed}s｜处理 ${this.lastSearchStats.processed} 组合｜候选队伍 ${this.lastSearchStats.totalCandidates || 0}`);
      }

      if (full) {
        const excludedServants = Array.from(new Set([...(this.excludedServants || []), ...(this.simpleExcludedServants || [])].map(Number)));
        const genericNotParticipating = this.genericBondCrafts.filter((c) => !this.isCraftParticipating(c)).map((c) => Number(c.id));
        const cnUnavailable = this.serverRegion === "cn" ? (this.cnUnavailableCraftIds || []).map(Number) : [];
        const excludedCrafts = Array.from(new Set([...(this.excludedCrafts || []).map(Number), ...cnUnavailable, ...genericNotParticipating, ...(this.nonParticipatingCraftIds || []).map(Number)]));
        const supportExcluded = Array.from(new Set([...cnUnavailable, ...genericNotParticipating, ...(this.nonParticipatingCraftIds || []).map(Number)]));

        const fixedServantTexts = [];
        const fixedCraftTexts = [];
        const crownTexts = [];
        for (let i = 0; i < this.slots.length; i += 1) {
          const slot = this.slots[i];
          const pos = this.slotPosition(i);
          if (slot.isCrown) crownTexts.push(this.positionLabel(pos));
          if (slot.isSupport) continue;
          if (slot.servantId) fixedServantTexts.push(`${this.servantMap[slot.servantId]?.name || slot.servantId}@${this.positionLabel(pos)}`);
          if (slot.craftId) fixedCraftTexts.push(`${this.craftById(slot.craftId)?.name || slot.craftId}@${this.positionLabel(pos)}`);
        }
        const supportSlot = this.slots.find((s) => s.isSupport);
        lines.push("");
        lines.push("【用于计算的队伍配置】");
        lines.push(`固定从者：${fixedServantTexts.join("、") || "无"}`);
        lines.push(`固定礼装：${fixedCraftTexts.join("、") || "无"}`);
        lines.push(`助战：${supportSlot && supportSlot.servantId ? (this.servantMap[supportSlot.servantId]?.name || supportSlot.servantId) : "自动"}${supportSlot && supportSlot.craftId ? `｜礼装：${this.craftById(supportSlot.craftId)?.name || supportSlot.craftId}` : ""}`);
        lines.push(`冠位位：${crownTexts.join("、") || "无"}`);
        lines.push(`排除从者：${excludedServants.length ? excludedServants.map((id) => this.servantMap[id]?.name || id).join("、") : "无"}`);
        lines.push(`排除礼装：${excludedCrafts.length ? excludedCrafts.map((id) => this.craftById(id)?.name || id).join("、") : "无"}`);
        lines.push(`助战排除礼装：${supportExcluded.length ? supportExcluded.map((id) => this.craftById(id)?.name || id).join("、") : "无"}`);

        const box = this.participatingBox();
        lines.push("");
        lines.push(`【参与计算的 Box（已排除）】共 ${box.length} 人`);
        for (const b of box) {
          lines.push(`  #${b.id} ${b.name}｜${b.class} ${b.rarity}★｜Cost ${b.cost}｜阶段 ${this.stageLabel(b.stage)}｜满绊 ${b.maxBond ? "是" : "否"}｜开关1 ${b.switch1 ? "开" : "关"}｜开关2 ${b.switch2 ? "开" : "关"}｜个人 +${(Number(b.personalBonus || 0) * 100).toFixed(2)}%｜光环 +${(Number(b.auraBonus || 0) * 100).toFixed(2)}%`);
        }

        const pool = this.feedbackCraftPool();
        lines.push("");
        lines.push(`【参与计算的礼装池】共 ${pool.length} 张`);
        for (const c of pool) {
          const effect = c.bonusType === "trait"
            ? `特性 +${(Number(c.bonusValue || 0) * 100).toFixed(1)}%（${c.trigger || "条件"}）`
            : `通用 +${(Number(c.bonusValue || 0) * 100).toFixed(1)}%`;
          lines.push(`  #${c.id} ${c.name}｜${c.rarity}★｜Cost ${c.cost}｜${effect}${c.flatBonus ? `｜固定 +${this.formatBondNumber(c.flatBonus)}` : ""}${c.repeatable ? "｜可重复" : ""}${c.isCustom ? "｜自定义" : ""}`);
        }
      }

      lines.push("");
      lines.push("【选中的方案】");
      for (const r of selected) {
        lines.push(`方案 #${r.rank}：x${Number(r.totalMultiplier).toFixed(3)}｜Cost ${r.costUsed}/${this.costLimit}${this.showsBondPoints(r) ? `｜预计牵绊 ${this.formatBondNumber(r.totalBondPoints)}` : ""}`);
        for (const m of r.team || []) {
          const name = m.isSupport ? `助战 ${this.resultMemberName(m)}` : this.resultMemberName(m);
          const crafts = this.resultCraftItems(m)
            .map((cm) => `${cm.craftName || "无礼装"}${cm.craftId !== null && cm.craftId !== undefined ? `(Cost ${this.craftCostById(cm.craftId)})` : ""}`)
            .filter(Boolean)
            .join(" + ");
          lines.push(`  ${this.positionLabel(m.position)}：${name}｜${crafts || "无礼装"}${m.isSupport ? "" : `｜x${Number(m.bonusDetail?.totalMultiplier || 0).toFixed(3)}`}`);
          if (!m.isSupport && m.craftBonusDetails && m.craftBonusDetails.length) {
            lines.push(`    礼装加成：${m.craftBonusDetails.map((d) => this.craftBonusDetailText(d)).join("；")}`);
          }
        }
        if (r.traitCoverage && r.traitCoverage.length) {
          lines.push(`  特性覆盖：${this.traitCoverageText(r)}`);
        }
        // 「选它就等于全选整组」：同分可替换阵容整组一起写进摘要，
        // 免得对方按摘要复现时只看到被合并后的那一支。
        const sameScore = this.sameScoreListFiltered(r);
        const hidden = this.sameScoreHiddenCount(r);
        if (sameScore.length > 1) {
          const shown = this.sameScoreChoiceIndex(r) + 1;
          lines.push(`  ── 同分可替换阵容共 ${this.sameScoreCount(r)} 支（分数完全相同 ${Number(r.totalMultiplier).toFixed(3)}x，礼装/站位相同）；本行当前显示第 ${shown} 支${hidden > 0 ? `（另有 ${hidden} 支含简易排除的从者，未列出）` : ""}：`);
          sameScore.forEach((alt, i) => {
            lines.push(`     同分${i + 1}${i + 1 === shown ? "（显示中）" : ""}：${this.sameScoreTeamText(r, alt)}`);
          });
        }
      }
      lines.push("");
      lines.push(full ? "（完整反馈摘要：含队伍配置、参与计算的 Box / 礼装池）" : "（简短反馈摘要；右键“复制反馈摘要”可切换完整模式）");
      try {
        await window.fgo.copyText(lines.join("\n"));
      } catch (e) {
        alert("复制失败：" + (e && e.message ? e.message : String(e)));
      }
    },
    servantBondInfo(s) {
      if (!s) return null;
      const b = this.box[s.id];
      if (!b || !b.checked) return null;
      let rank = Number(b.bondRank || 0);
      let max = Number(b.bondMaxRank || 0);
      // 旧数据/手动只有满绊标记时：按现有“满绊类型”给出可显示的上限
      if (rank <= 0 || max <= 0) {
        if (!b.maxBond) return null;
        if (b.switch1) { rank = 15; max = 15; }
        else { rank = 10; max = 10; }
      }
      if (rank <= 0) return null;
      if (max <= 0) max = Math.max(rank, 10);
      return {
        rank,
        max,
        text: `${rank}/${max}`,
        kind: b.maxBond ? (b.switch1 ? "active" : "full") : "",
      };
    },
    sortServantList(list, sortBy, sortOrder) {
      const dir = String(sortOrder) === "asc" ? 1 : -1;
      return (list || []).slice().sort((a, b) => {
        if (sortBy !== "bond") {
          return (Number(a.collectionNo) - Number(b.collectionNo)) * dir;
        }
        const ia = this.servantBondInfo(a);
        const ib = this.servantBondInfo(b);
        const ua = ia ? 0 : 1;
        const ub = ib ? 0 : 1;
        if (ua !== ub) return ua - ub; // 无牵绊数据的人始终排最后
        if (!ia || !ib) return (Number(a.collectionNo) - Number(b.collectionNo)) * dir;
        if (ia.rank !== ib.rank) return (ia.rank - ib.rank) * dir;
        if (ia.max !== ib.max) return (ia.max - ib.max) * dir;
        return (Number(a.collectionNo) - Number(b.collectionNo)) * dir;
      });
    },
    stageLabel(s) { return STAGE_LABELS[s] || s; },
    stageNumber(s) {
      if (String(s || "").startsWith("costume_")) return "灵衣";
      return { initial: 0, first: 1, second: 2, third: 3, fourth: 4 }[s] ?? "";
    },
    positionLabel(pos) { return POSITION_LABELS[pos] || pos; },
    slotServant(slot) { return this.servantMap[slot.servantId] || null; },
    craftById(craftId) {
      if (craftId === -10) return this.universal5Craft;
      if (craftId === 0 || (craftId && craftId < 0)) {
        const syn = this.otherCraftOptions.find((o) => o.id === craftId);
        if (syn) return syn;
        const generic = this.genericBondCrafts.find((o) => o.id === Number(craftId));
        if (generic) return generic;
      }
      return this.craftMap[craftId] || null;
    },
    slotCraft(slot) {
      return this.craftById(slot.craftId);
    },
    slotCraftAt(slot, index) {
      return index === 1 ? this.craftById(slot.secondCraftId) : this.slotCraft(slot);
    },
    slotCraftItems(slot) {
      const items = [{ index: 0, craftId: slot.craftId, craft: this.slotCraft(slot) }];
      if (this.mode === "crown" && slot.isCrown) {
        items.push({ index: 1, craftId: slot.secondCraftId, craft: this.craftById(slot.secondCraftId) });
      }
      return items;
    },
    onServantDragStart(e, slotIndex) {
      const slot = this.slots[slotIndex];
      if (!slot || !slot.servantId) return;
      this.dragState = { type: "servant", slotIndex, craftIndex: null };
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `servant:${slotIndex}`);
      } catch (_) {
        // 旧环境不支持 dataTransfer 时忽略
      }
    },
    onCraftDragStart(e, slotIndex, craftIndex) {
      const slot = this.slots[slotIndex];
      if (!slot) return;
      const craftId = Number(craftIndex) === 1 ? slot.secondCraftId : slot.craftId;
      if (craftId === null || craftId === undefined || Number(craftId) === 0) return;
      this.dragState = { type: "craft", slotIndex, craftIndex: Number(craftIndex) };
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `craft:${slotIndex}:${craftIndex}`);
      } catch (_) {
        // 旧环境不支持 dataTransfer 时忽略
      }
    },
    onSlotDragOver(e, slotIndex) {
      if (!this.dragState.type) return;
      if (e) e.preventDefault();
      this.dragOverSlot = slotIndex;
      this.dragOverCraft = null;
    },
    onCraftDragOver(e, slotIndex, craftIndex) {
      if (!this.dragState.type) return;
      if (e) e.preventDefault();
      this.dragOverSlot = slotIndex;
      this.dragOverCraft = Number(craftIndex);
    },
    onSlotDrop(_e, slotIndex) {
      if (this.dragState.type === "servant") {
        this.swapSlots(this.dragState.slotIndex, slotIndex);
      } else if (this.dragState.type === "craft") {
        const sourceCraftIndex = Number(this.dragState.craftIndex);
        const targetSlot = this.slots[slotIndex];
        if (sourceCraftIndex === 0) {
          this.swapCraft(this.dragState.slotIndex, 0, slotIndex, 0);
        } else if (targetSlot && targetSlot.isCrown) {
          this.swapCraft(this.dragState.slotIndex, 1, slotIndex, 1);
        }
      }
      this.clearDragState();
    },
    onCraftDrop(_e, slotIndex, craftIndex) {
      if (this.dragState.type === "servant") {
        this.swapSlots(this.dragState.slotIndex, slotIndex);
      } else if (this.dragState.type === "craft") {
        this.swapCraft(
          this.dragState.slotIndex,
          this.dragState.craftIndex,
          slotIndex,
          Number(craftIndex)
        );
      }
      this.clearDragState();
    },
    swapSlots(a, b) {
      if (a === b || a === null || b === null) return;
      const left = this.slots[a];
      this.slots[a] = this.slots[b];
      this.slots[b] = left;
    },
    swapCraft(a, ai, b, bi) {
      if (a === b && Number(ai) === Number(bi)) return;
      const left = this.slots[a];
      const right = this.slots[b];
      if (!left || !right) return;
      const leftKey = Number(ai) === 1 ? "secondCraftId" : "craftId";
      const rightKey = Number(bi) === 1 ? "secondCraftId" : "craftId";
      const tmp = left[leftKey];
      left[leftKey] = right[rightKey];
      right[rightKey] = tmp;
    },
    clearDragState() {
      this.dragState = { type: null, slotIndex: null, craftIndex: null };
      this.dragOverSlot = null;
      this.dragOverCraft = null;
    },
    resultCraftItems(member) {
      const items = [{
        index: 0,
        craftId: member.craftId,
        craftName: member.craftName || "",
        craftType: member.craftType || "other",
        hasImage: this.hasCraftImageId(member.craftId),
      }];
      if (member.secondCraftId !== null && member.secondCraftId !== undefined) {
        items.push({
          index: 1,
          craftId: member.secondCraftId,
          craftName: member.secondCraftName || "",
          craftType: member.secondCraftType || "other",
          hasImage: this.hasCraftImageId(member.secondCraftId),
        });
      }
      return items;
    },
    resultMemberStage(member) {
      if (!member) return "";
      const stage = String(member.stage || "fourth");
      if (stage.startsWith("costume_")) {
        const cid = stage.split("_")[1];
        return this.costumeNames[String(cid)] ? `灵衣：${this.costumeNames[String(cid)]}` : "灵衣";
      }
      return this.stageLabel(stage);
    },
    resultMemberClass(member) {
      const s = member && this.servantMap[member.servantId];
      return s ? s.class : "";
    },
    resultBonusParts(member) {
      if (!member || member.isSupport || !member.bonusDetail) return [];
      const d = member.bonusDetail;
      const out = [];
      const percent = (v) => v ? `${(Number(v) * 100).toFixed(1).replace(/\.0$/, "")}%` : "";
      if (Number(d.frontlineBonus || 0) > 0) out.push({ label: "前排", value: percent(d.frontlineBonus) });
      if (Number(d.universalCraftBonus || 0) > 0) out.push({ label: "通用礼装", value: percent(d.universalCraftBonus) });
      if (Number(d.supportCraftBonus || 0) > 0) out.push({ label: "助战礼装", value: percent(d.supportCraftBonus) });
      if (Number(d.traitCraftBonus || 0) > 0) out.push({ label: "特性礼装", value: percent(d.traitCraftBonus) });
      if (Number(d.maxBondBonus || 0) > 0) out.push({ label: "满绊加成", value: percent(d.maxBondBonus) });
      if (Number(d.activityBonus || 0) > 0) out.push({ label: "活动加成", value: percent(d.activityBonus) });
      if (Number(d.auraBonus || 0) > 0) out.push({ label: "玛修光环", value: percent(d.auraBonus) });
      if (Number(d.personalBonus || 0) > 0) out.push({ label: "个人", value: percent(d.personalBonus) });
      if (Number(d.flatCraftBonus || 0) > 0) out.push({ label: "固定", value: `+${this.formatBondNumber(d.flatCraftBonus)}` });
      return out;
    },
    resultTeamCrafts(result) {
      if (!result || !Array.isArray(result.team)) return [];
      const seen = new Set();
      const out = [];
      for (const m of this.visibleResultTeam(result)) {
        const ids = [m.craftId, m.secondCraftId];
        for (const cid of ids) {
          if (cid === null || cid === undefined || cid === 0 || cid === "") continue;
          const key = Number(cid);
          if (seen.has(key)) continue;
          const c = this.craftById(cid);
          if (!c) continue;
          seen.add(key);
          out.push(c);
        }
      }
      return out;
    },
    craftEffect(c) {
      if (!c) return "";
      return c.detail || c.name || "";
    },
    customCraftDetail(c) {
      if (!c) return "";
      const isBond = c.craftType === "bond";
      const parts = [];
      const percent = Number(c.percentBonus || 0);
      const flat = Number(c.flatBonus || 0);
      if (percent > 0) parts.push(`牵绊加成 ${percent}%`);
      if (flat > 0) parts.push(`最终牵绊固定 +${flat}`);
      const groups = Array.isArray(c.conditionGroups) ? c.conditionGroups : [];
      let suffix = "";
      if (isBond && groups.length) {
        suffix = "（" + groups
          .map((g) => (Array.isArray(g) ? g.map((t) => this.traitLabel(t)).join(" 且 ") : ""))
          .filter(Boolean)
          .join(" 或 ") + "）";
      }
      return `自定义${isBond ? "牵绊" : "其他"}礼装${parts.length ? "：" + parts.join("、") + suffix : ""}`;
    },
    customToCraft(c) {
      if (!c) return null;
      const isBond = c.craftType === "bond";
      const groups = Array.isArray(c.conditionGroups) ? c.conditionGroups : [];
      const percent = Number(c.percentBonus || 0);
      const flat = Number(c.flatBonus || 0);
      const bonusType = isBond
        ? (groups.length ? "trait" : ((percent > 0 || flat > 0) ? "universal" : null))
        : null;
      return {
        id: Number(c.id),
        name: String(c.name || "").trim() || "未命名礼装",
        cost: Number(c.cost || 0),
        rarity: Number(c.rarity || 0),
        bonusType,
        bonusValue: percent / 100,
        supportBonus: 0,
        triggerTraitsJson: JSON.stringify(groups),
        detail: this.customCraftDetail(c),
        isBondCe: isBond,
        isEventLimited: false,
        craftType: c.craftType,
        flatBonus: flat,
        repeatable: !!c.repeatable,
        isCustom: true,
        enabled: c.enabled === false ? false : true,
        customRaw: c,
      };
    },
    hasCraftImageId(craftId) {
      return CRAFT_IMAGE_IDS.has(Number(craftId));
    },
    hasCraftImage(c) {
      return !!(c && c.id !== undefined && this.hasCraftImageId(c.id));
    },
    craftImagePathId(craftId) {
      return `./assets/craftface/${craftId}.png`;
    },
    craftImagePath(c) {
      return c && c.id !== undefined ? this.craftImagePathId(c.id) : "";
    },
    isGenericUniversal5Actual(c) {
      // 把普通（无助战加成）的 5% 通用牵绊礼装合并成上面的“通用5%”
      return (
        c &&
        !c.isCustom &&
        c.bonusType === "universal" &&
        Math.abs((c.bonusValue || 0) - 0.05) < 1e-9 &&
        !(Number(c.supportBonus || 0) > 0)
      );
    },
    isCnUnavailableCraft(c) {
      // 简中服模式下，把本地识别出的“国服尚未实装”礼装从可选库/自动计算中排除
      if (!c) return false;
      return this.serverRegion === "cn" && this.cnUnavailableCraftSet.has(Number(c.id));
    },
    async setServerRegion(region) {
      const next = region === "cn" ? "cn" : "jp";
      const previous = this.serverRegion;
      if (previous === next) return;
      this.serverRegion = next;
      this.results = [];
      this.currentPage = 1;
      try {
        await window.fgo.setServerRegion(next);
        await this.reloadAllData();
      } catch (e) {
        this.serverRegion = previous;
        this.error = "保存服务器设置失败：" + (e.message || String(e));
      }
    },
    slotPosition(i) { return POSITION_KEYS[i]; },
    matchesClassFilter(servantClass, filterValue) {
      if (!filterValue || filterValue === "all") return true;
      const c = String(servantClass || "").toLowerCase();
      const f = String(filterValue).toLowerCase();
      if (f === "beast") return c.includes("beast");
      return c === f;
    },
    matchesCrownClassFilter(servantClass, crownFilter) {
      const groups = CROWN_CLASS_GROUPS[crownFilter];
      if (!groups) return true;
      return groups.some((g) => String(servantClass || "").toLowerCase() === g.toLowerCase());
    },
    crownClassFilters() { return CROWN_CLASS_FILTERS; },
    avatarPath(servantId) {
      const local = this.localAvatars && this.localAvatars[String(servantId)];
      if (local) return local;
      return `./assets/servantface/${servantId}.png`;
    },
    markAvatarBroken(id) {
      const key = String(id);
      if (!this.avatarBroken.includes(key)) this.avatarBroken.push(key);
      // 头像缺失时顺手补一张（每个 id 只试一次；安卓端没有这个接口，会直接跳过）
      this.requestAvatar(key);
    },
    /**
     * 取一张本机没有的头像：主进程先找本地（运行时补下来的），没有才去下载。
     * 拿到后换成 data URL 显示；拿不到就维持"没有头像"的现状，不弹错、不重试。
     */
    async requestAvatar(id) {
      const key = String(id);
      if (this.avatarTried[key]) return;
      this.avatarTried[key] = true;
      const api = window.fgo;
      if (!api || typeof api.getAvatarData !== "function") return;
      try {
        const r = await api.getAvatarData(key);
        if (!r || !r.ok || !r.dataUrl) return;
        this.localAvatars = Object.assign({}, this.localAvatars, { [key]: r.dataUrl });
        const idx = this.avatarBroken.indexOf(key);
        if (idx >= 0) this.avatarBroken.splice(idx, 1);
      } catch (_) {
        // 取不到就当作没有头像（与现状一致），不打扰用户
      }
    },
    /** 更新数据之后重试之前坏掉的头像（这时本地多半已经补上了，不会再走网络） */
    retryBrokenAvatars() {
      const ids = this.avatarBroken.slice();
      this.avatarTried = {};
      ids.forEach((id) => this.requestAvatar(id));
    },
    // ---------------- 诊断日志（设置里查看 / 复制；安卓端最需要，桌面也有） ----------------
    diagLogAvailable() {
      return !!(window.fgo && typeof window.fgo.getDiagnosticLog === "function");
    },
    async loadDiagnosticLog() {
      this.diagLogNote = "";
      try {
        const r = await window.fgo.getDiagnosticLog();
        this.diagLogText = (r && r.text) || "";
        this.diagLogLines = this.diagLogText ? this.diagLogText.split("\n").length : 0;
        this.diagLogLoaded = true;
      } catch (e) {
        this.diagLogText = "";
        this.diagLogLines = 0;
        this.diagLogLoaded = true;
        this.diagLogNote = "读取失败：" + (e && e.message ? e.message : String(e));
      }
    },
    async copyDiagnosticLog() {
      if (!this.diagLogText) return;
      try {
        await window.fgo.copyText(this.diagLogText);
        this.diagLogNote = "已复制到剪贴板";
      } catch (e) {
        this.diagLogNote = "复制失败：" + (e && e.message ? e.message : String(e));
      }
    },
    async clearDiagnosticLog() {
      try {
        await window.fgo.clearDiagnosticLog();
        this.diagLogText = "";
        this.diagLogLines = 0;
        this.diagLogLoaded = true;
        this.diagLogNote = "已清空";
      } catch (e) {
        this.diagLogNote = "清空失败：" + (e && e.message ? e.message : String(e));
      }
    },
    /**
     * 触屏设备（安卓 / 安卓模拟器 / 手机）上没有"悬停"，但安卓 WebView 会在点按时补发
     * mouseenter / mousemove，导致提示条弹出后**不会消失**（因为没有 mouseleave）。
     * 用户明确要求安卓端不要这个提示 → 触屏设备直接禁用（桌面端行为不变）。
     */
    hoverTipDisabled() {
      try {
        if (navigator.maxTouchPoints > 0) return true;
        if (window.matchMedia && window.matchMedia("(hover: none)").matches) return true;
      } catch (_) {
        /* 忽略探测失败 */
      }
      return false;
    },
    showHover(e, servant) {
      if (!servant) return;
      if (this.dragSelectActive()) return;
      if (this.hoverTipDisabled()) return;
      clearTimeout(this._hoverTimer);
      this._hoverTimer = setTimeout(() => {
        this.hover = { visible: true, x: e.clientX + 14, y: e.clientY + 14, text: servant.name };
      }, 600);
    },
    moveHover(e) {
      if (this.hover.visible) {
        this.hover.x = e.clientX + 14;
        this.hover.y = e.clientY + 14;
      }
    },
    hideHover() {
      clearTimeout(this._hoverTimer);
      this.hover.visible = false;
    },

    // ---------------- 按住滑动批量选择（仅电脑端鼠标 / 触控板） ----------------
    // 手感对齐"选文本"：
    //   · 按住不动 → 交给原有 click（单击行为完全不变）
    //   · 按住 + 滑动 → 起点到当前格划出连续区间，按"起点状态取反"预览
    //   · 往回拖 → 划出区间的格子自动恢复原状态（不是"划过就留下"）
    //   · 松手 → 一次性提交（只写一次库）
    dragSelectActive() {
      return !!(this._drag && this._drag.active);
    },
    // 单元格"生效状态"：拖动预览优先，否则取真实状态
    cellState(kind, id) {
      const key = String(id);
      const pending = this.dragSelectPending;
      if (pending && Object.prototype.hasOwnProperty.call(pending, key)) return !!pending[key];
      if (kind === "owned") return !!(this.box[id] && this.box[id].checked);
      if (kind === "batch") return this.batchSelectedServants.includes(id);
      return this.isExcludedServant(id);
    },
    dragGridOf(el) {
      return el && el.closest ? el.closest(".box-grid, .exclusion-grid") : null;
    },
    dragIndexAtPoint(d, x, y) {
      // 用 elementsFromPoint（复数）：菜单/气泡这类浮层可能还盖在格子上
      // （触摸端"长按弹菜单→继续滑"时，菜单这一帧还没从 DOM 里消失），
      // 单数版只会返回最上面那个浮层，导致选区圈不到底下的格子。
      const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
      for (const el of stack) {
        const cell = el && el.closest ? el.closest("[data-cell-id]") : null;
        if (cell && d.container.contains(cell)) {
          const idx = d.cells.indexOf(cell);
          if (idx >= 0) return idx;
        }
      }
      // 指针移出网格：停在上一次的位置，不越界也不乱跳
      return d.lastIndex;
    },
    dragRequeryCells(d) {
      const first = d.cells[d.anchorIndex];
      if (first && first.isConnected) return;
      d.cells = Array.from(d.container.querySelectorAll("[data-cell-id]"));
      const again = d.cells.findIndex((el) => Number(el.dataset.cellId) === d.id);
      if (again >= 0) d.anchorIndex = again;
    },
    dragPreviewTo(d, idx) {
      const lo = Math.max(0, Math.min(d.anchorIndex, idx));
      const hi = Math.min(d.cells.length - 1, Math.max(d.anchorIndex, idx));
      const next = {};
      for (let i = lo; i <= hi; i++) {
        const el = d.cells[i];
        if (el) next[String(el.dataset.cellId)] = d.target;
      }
      // 整体替换：被拖出去的格子自动回到真实状态
      this.dragSelectPending = next;
    },
    onCellDragStart(event, kind, id) {
      if (event.button !== 0) return;            // 只认左键（右键留给详情菜单）
      // 只做电脑端：安卓是触摸滚动列表，别去抢事件（否则可能卡住滚动）
      try { if (this.isAndroidPlatform && this.isAndroidPlatform()) return; } catch (_) { /* ignore */ }
      if (this.dragSelectActive()) return;
      const container = this.dragGridOf(event.currentTarget);
      if (!container) return;
      const cells = Array.from(container.querySelectorAll("[data-cell-id]"));
      const anchorIndex = cells.findIndex((el) => Number(el.dataset.cellId) === Number(id));
      if (anchorIndex < 0) return;
      event.preventDefault();                     // 阻止图片原生拖动 / 文本选择
      this.hideHover();
      this._drag = {
        active: true, kind, id: Number(id), container, cells,
        anchorIndex, target: !this.cellState(kind, id),   // 起点取反 = 本次操作方向
        startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY,
        moved: false, lastIndex: anchorIndex, autoDy: 0, raf: null,
      };
      window.addEventListener("mousemove", this.onCellDragMove, { passive: false });
      window.addEventListener("mouseup", this.onCellDragEnd);
    },
    onCellDragMove(event) {
      const d = this._drag;
      if (!d || !d.active) return;
      d.lastX = event.clientX;
      d.lastY = event.clientY;
      if (!d.moved) {
        if (Math.abs(event.clientX - d.startX) < 4 && Math.abs(event.clientY - d.startY) < 4) return;
        d.moved = true;
        document.body.classList.add("drag-selecting");
        this.dragPreviewTo(d, d.anchorIndex);
        this.startDragAutoScroll(d);
      }
      event.preventDefault();
      this.dragRequeryCells(d);
      const idx = this.dragIndexAtPoint(d, event.clientX, event.clientY);
      if (idx !== d.lastIndex) {
        d.lastIndex = idx;
        this.dragPreviewTo(d, idx);
      }
      this.updateDragAutoScroll(d);
    },
    updateDragAutoScroll(d) {
      const rect = d.container.getBoundingClientRect();
      const EDGE = 44;
      const MAX = 18;
      if (d.lastY < rect.top + EDGE) d.autoDy = -Math.min(MAX, Math.max(4, (rect.top + EDGE - d.lastY) / 2));
      else if (d.lastY > rect.bottom - EDGE) d.autoDy = Math.min(MAX, Math.max(4, (d.lastY - (rect.bottom - EDGE)) / 2));
      else d.autoDy = 0;
    },
    startDragAutoScroll(session) {
      const s = session || this._drag;
      if (!s || s.raf) return;
      const step = () => {
        const d = s;
        if (!d || !d.active) return;
        if (d.autoDy) {
          const before = d.container.scrollTop;
          d.container.scrollTop = before + d.autoDy;
          if (d.container.scrollTop !== before) {
            const idx = this.dragIndexAtPoint(d, d.lastX, d.lastY);
            if (idx !== d.lastIndex) {
              d.lastIndex = idx;
              this.dragPreviewTo(d, idx);
            }
          }
        }
        d.raf = requestAnimationFrame(step);
      };
      s.raf = requestAnimationFrame(step);
    },
    async onCellDragEnd() {
      const d = this._drag;
      window.removeEventListener("mousemove", this.onCellDragMove);
      window.removeEventListener("mouseup", this.onCellDragEnd);
      this._drag = null;
      document.body.classList.remove("drag-selecting");
      if (d && d.raf) cancelAnimationFrame(d.raf);
      if (!d || !d.moved) {
        this.dragSelectPending = {};   // 没滑动 = 普通单击，交回原 click 处理
        return;
      }
      const pending = this.dragSelectPending;
      this.dragSelectPending = {};
      // 松手后浏览器还会补一个 click（落在起点与终点公共祖先上）→ 屏蔽掉，否则会多切一格
      this._suppressDragClick = true;
      setTimeout(() => { this._suppressDragClick = false; }, 0);
      await this.commitDragSelection(d.kind, pending);
    },
    dragClickSuppressed() {
      if (this._suppressDragClick) return true;
      if (this.dragSelectActive()) return true;
      return false;
    },
    async commitDragSelection(kind, pending) {
      const ids = Object.keys(pending || {}).map(Number);
      if (!ids.length) return;
      if (kind === "exclusion") {
        const set = new Set(this.excludedServants.map(Number));
        for (const id of ids) { if (pending[String(id)]) set.add(id); else set.delete(id); }
        this.excludedServants = Array.from(set);
        await this.persistExclusions();
        return;
      }
      if (kind === "batch") {
        const set = new Set(this.batchSelectedServants.map(Number));
        for (const id of ids) { if (pending[String(id)]) set.add(id); else set.delete(id); }
        this.batchSelectedServants = this.ownedServants.map((s) => s.id).filter((id) => set.has(id));
        return;
      }
      // owned：副作用对齐 toggleOwned（取消持有时清满绊/开关、并从队伍里摘掉），但只存一次
      for (const id of ids) {
        const b = this.box[id];
        if (!b) continue;
        const want = !!pending[String(id)];
        if (!!b.checked === want) continue;
        b.checked = want;
        if (!want) {
          b.maxBond = false;
          b.switch1 = false;
          b.switch2 = false;
          for (const slot of this.slots) {
            if (slot.servantId === id) { slot.servantId = null; slot.craftId = null; slot.secondCraftId = null; }
          }
        }
      }
      await this.persistBox();
    },

    // ---------------- 触摸端（安卓）：长按菜单 + 长按后滑动批量选择 ----------------
    // 手感（与桌面版同一套划选内核，区别只在"怎么启动"）：
    //   · 快速滑动           → 就是滚列表（没长按就不抢事件）
    //   · 长按不动 0.5 秒    → 弹出自己的菜单（从者设置 / 从者属性），可以抬手去点
    //   · 长按后手指不松继续滑 → 菜单淡出，直接进入划选，抬手提交
    // 为什么不用系统自带的长按菜单：那个菜单我们关不掉，也挡着格子（详见 CONTEXT 文档）
    onCellTouchStart(event, kind, id) {
      if (this._touch) return;
      const t = event.touches && event.touches[0];
      if (!t) return;
      const container = this.dragGridOf(event.currentTarget);
      if (!container) return;
      const cells = Array.from(container.querySelectorAll("[data-cell-id]"));
      const anchorIndex = cells.findIndex((el) => Number(el.dataset.cellId) === Number(id));
      if (anchorIndex < 0) return;
      const d = {
        kind, id: Number(id), container, cells, anchorIndex,
        target: !this.cellState(kind, id),
        startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY,
        mode: "idle", lastIndex: anchorIndex, autoDy: 0, raf: null,
        timer: setTimeout(() => this.enterTouchMenu(d), 500),
      };
      this._touch = d;
      window.addEventListener("touchmove", this.onCellTouchMove, { passive: false });
      window.addEventListener("touchend", this.onCellTouchEnd);
      window.addEventListener("touchcancel", this.onCellTouchCancel);
    },
    enterTouchMenu(d) {
      if (this._touch !== d || d.mode !== "idle") return;
      d.mode = "menu";
      const maxX = Math.max(8, window.innerWidth - 210);
      const maxY = Math.max(8, window.innerHeight - 150);
      this.hideHover();
      this.contextMenu = {
        visible: true, target: "box", servantId: d.id, slotIndex: null,
        x: Math.min(Math.max(8, d.startX), maxX),
        y: Math.min(Math.max(8, d.startY), maxY),
      };
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) { /* 没权限就算了 */ }
    },
    onCellTouchMove(event) {
      const d = this._touch;
      if (!d) return;
      const t = event.touches && event.touches[0];
      if (!t) return;
      d.lastX = t.clientX;
      d.lastY = t.clientY;
      const dist = Math.hypot(t.clientX - d.startX, t.clientY - d.startY);
      if (d.mode === "idle") {
        // 还没长按成功就滑动 → 判定为滚列表，彻底让开（不 preventDefault）
        if (dist > 15) { clearTimeout(d.timer); this.endTouchSession(); }
        return;
      }
      // 已经进菜单 / 划选：这整个手势都不许列表跟着滚
      if (event.cancelable) event.preventDefault();
      if (d.mode === "menu") {
        if (dist <= 15) return;
        d.mode = "select";
        this.closeContextMenu();               // 菜单淡出，进入划选
        document.body.classList.add("drag-selecting");
        this.dragRequeryCells(d);
        d.lastIndex = d.anchorIndex;
        this.updateDragAutoScroll(d);
        this.startDragAutoScroll(d);
        // 不 return：这一次滑动就该把选区算到当前格子（否则手指划一下就停会只圈到起点）
      }
      this.dragRequeryCells(d);
      const idx = this.dragIndexAtPoint(d, t.clientX, t.clientY);
      if (idx !== d.lastIndex) {
        d.lastIndex = idx;
        this.dragPreviewTo(d, idx);
      }
      this.updateDragAutoScroll(d);
    },
    onCellTouchEnd(event) {
      const d = this._touch;
      if (!d) return;
      clearTimeout(d.timer);
      if (d.mode === "idle") {
        this.endTouchSession();                // 普通点按：交给原有 click
        return;
      }
      // 长按（菜单 or 划选）都要吃掉这次合成 click：
      // 否则会多切一格、或者刚弹出的菜单被根节点的 click 立刻关掉
      if (event.cancelable) event.preventDefault();
      this._suppressDragClick = true;
      setTimeout(() => { this._suppressDragClick = false; }, 0);
      if (d.mode === "select") {
        const pending = this.dragSelectPending;
        this.dragSelectPending = {};
        this.endTouchSession();
        this.commitDragSelection(d.kind, pending);
      } else {
        this.endTouchSession();                // 菜单留着，等用户点
      }
    },
    onCellTouchCancel() {
      this.closeContextMenu();
      this.dragSelectPending = {};
      this.endTouchSession();
    },
    endTouchSession() {
      const d = this._touch;
      if (d && d.timer) clearTimeout(d.timer);
      if (d && d.raf) cancelAnimationFrame(d.raf);
      this._touch = null;
      document.body.classList.remove("drag-selecting");
      window.removeEventListener("touchmove", this.onCellTouchMove);
      window.removeEventListener("touchend", this.onCellTouchEnd);
      window.removeEventListener("touchcancel", this.onCellTouchCancel);
    },
    async openServantDetail(servantId, slotIndex = null) {
      this.servantDetail.servantId = servantId;
      this.servantDetail.slotIndex = slotIndex;
      this.servantDetail.visible = true;
      if (!(this.eventBondBonuses || []).length) {
        try {
          this.eventBondBonuses = await window.fgo.getEventBondBonuses();
        } catch (_) {
          this.eventBondBonuses = [];
        }
      }
      const sid = Number(servantId);
      const withBonus = (this.eventBondEvents || []).filter(
        (ev) => this.eventBonusForServant(ev, sid) !== null
      );
      this.servantDetailEventId = withBonus.length ? String(withBonus[0].eventId) : "";
    },
    openServantAttr(servantId) {
      const sid = Number(servantId);
      if (!this.servantMap[sid]) return;
      this.servantAttr = { visible: true, servantId: sid, stage: "fourth", rows: [], loading: false };
      this.loadServantAttrTraits();
    },
    closeServantAttr() {
      this.servantAttr.visible = false;
    },
    servantAttrOptions() {
      const sid = Number(this.servantAttr.servantId);
      const servant = this.servantMap[sid];
      const options = [];
      STAGES.forEach((s) => options.push({ value: s, label: STAGE_LABELS[s] }));
      if (servant) {
        (servant.costumes || []).forEach((cid) => {
          const name = this.costumeNames[String(cid)];
          options.push({ value: `costume_${cid}`, label: name ? `灵衣：${name}` : `灵衣 ${cid}` });
        });
      }
      return options;
    },
    async loadServantAttrTraits() {
      const sid = Number(this.servantAttr.servantId);
      const stage = this.servantAttr.stage;
      if (!sid || !stage) return;
      this.servantAttr.loading = true;
      try {
        const traits = await window.fgo.getStageTraits(sid, stage, this.serverRegion);
        this.servantAttr.rows = (traits || []).map((t) => ({ label: t, active: false }));
      } catch (e) {
        this.servantAttr.rows = [];
        this.servantAttr.error = (e && e.message) || String(e);
      } finally {
        this.servantAttr.loading = false;
      }
    },
    ctxServantAttr() {
      const { servantId, slotIndex } = this.contextMenu;
      const sid = servantId !== undefined ? servantId : (slotIndex !== null ? this.slots[slotIndex].servantId : null);
      this.closeContextMenu();
      if (sid !== null) this.openServantAttr(sid);
    },
    servantEventRecord(ev, servantId) {
      const sid = Number(servantId);
      if (!ev || !sid) return null;
      for (const rec of ev.bonuses || []) {
        if (rec.allServants) return rec;
        if ((rec.servantIds || []).includes(sid)) return rec;
      }
      return null;
    },
    eventBonusForServant(ev, servantId) {
      const rec = this.servantEventRecord(ev, servantId);
      return rec ? Number(rec.bonusPercent || 0) : null;
    },
    servantEventOptionLabel(ev, servantId) {
      const rec = this.servantEventRecord(ev, servantId);
      if (!rec) return ev.eventName || "";
      const kind = rec.scope === "team" ? "光环" : "个人";
      return `${ev.eventName || ""}（${kind}+${Number(rec.bonusPercent || 0)}%）`;
    },
    servantDetailEvents() {
      const sid = Number(this.servantDetail.servantId);
      const events = this.eventBondEvents || [];
      const withBonus = events.filter((ev) => this.servantEventRecord(ev, sid) !== null);
      return withBonus.length ? withBonus : events;
    },
    servantDetailBonusText() {
      const sid = Number(this.servantDetail.servantId);
      if (!this.servantDetailEventId || !sid) return "";
      const ev = (this.eventBondEvents || []).find(
        (e) => e.eventId === Number(this.servantDetailEventId)
      );
      if (!ev) return "";
      const rec = this.servantEventRecord(ev, sid);
      if (!rec) return "该活动没有此从者加成，导入会将个人/光环加成恢复为 0";
      const scopeLabel = rec.scope === "team" ? "全队光环" : "个人加成";
      return `该活动对此从者的${scopeLabel}为 +${Number(rec.bonusPercent || 0)}%`;
    },
    applyServantDetailEventBonus() {
      const sid = Number(this.servantDetail.servantId);
      if (!sid || !this.box[sid]) return;
      const ev = (this.eventBondEvents || []).find(
        (e) => e.eventId === Number(this.servantDetailEventId)
      );
      if (!ev) {
        alert("请先选择一个活动");
        return;
      }
      const rec = this.servantEventRecord(ev, sid);
      const name = this.servantMap[sid] ? this.servantMap[sid].name : `#${sid}`;
      if (!rec) {
        this.box[sid].personalBonus = 0;
        this.box[sid].auraBonus = 0;
        this.persistBox();
        alert(`活动「${ev.eventName}」没有 ${name} 的加成，已将该从者个人/光环加成恢复为 0`);
        return;
      }
      const pct = Number(rec.bonusPercent || 0);
      if (rec.scope === "team") {
        this.box[sid].personalBonus = 0;
        this.box[sid].auraBonus = pct;
      } else {
        this.box[sid].auraBonus = 0;
        this.box[sid].personalBonus = pct;
      }
      this.persistBox();
      const label = rec.scope === "team" ? "全队光环" : "个人加成";
      alert(`已将 ${name} 的${label}设为 ${pct}%`);
    },
    servantStageOptions(slotIndex) {
      const servant = this.slots[slotIndex] && this.servantMap[this.slots[slotIndex].servantId];
      const options = [{ value: "", label: "自动选择（由引擎根据礼装决定）" }];
      if (!servant) return options;
      STAGES.forEach((s) => options.push({ value: s, label: STAGE_LABELS[s] }));
      (servant.costumes || []).forEach((cid, idx) => {
        const name = this.costumeNames[String(cid)];
        options.push({
          value: `costume_${cid}`,
          label: name ? `灵衣：${name}` : `灵衣 ${idx + 1}`,
        });
      });
      return options;
    },
    setSlotStage(slotIndex, value) {
      if (this.slots[slotIndex]) {
        this.slots[slotIndex].stage = value || null;
      }
    },

    // ---------- Box ----------
    // ---------- 多账号（一个账号 = 一套 Box + 一套排除列表） ----------
    applyBoxRows(rows) {
      const saved = {};
      (rows || []).forEach((e) => {
        saved[e.servantId] = {
          checked: true,
          stage: e.stage || "fourth",
          maxBond: !!e.isMaxBond,
          switch1: e.bondSwitch1 !== 0,
          switch2: !!e.bondSwitch2,
          personalBonus: e.personalBonus || 0,
          auraBonus: e.auraBonus || 0,
          bondRank: e.bondRank || 0,
          bondMaxRank: e.bondMaxRank || 0,
          // 玛修的 Cost 覆盖（0/16）；null/undefined = 不覆盖
          costOverride: e.costOverride === null || e.costOverride === undefined ? null : Number(e.costOverride),
        };
      });
      this.servants.forEach((s) => {
        if (!saved[s.id]) {
          saved[s.id] = { checked: false, stage: "fourth", maxBond: false, switch1: false, switch2: false, personalBonus: 0, auraBonus: 0, bondRank: 0, bondMaxRank: 0, costOverride: null };
        }
      });
      this.box = saved;
      // 等级已知的从者：三个标记按规则推导一次（老库手勾的、等级为 0 的不动）
      this.syncBondFlags();
    },
    activeAccountName() {
      const hit = this.accounts.find((a) => a.id === this.activeAccountId);
      return hit ? hit.name : "账号";
    },
    applyAccountResult(res) {
      if (!res) return;
      if (Array.isArray(res.accounts)) this.accounts = res.accounts;
      if (res.activeId) this.activeAccountId = Number(res.activeId);
    },
    openAccountManager() {
      this.accountModalVisible = true;
      this.accountError = "";
      this.accountEditingId = null;
      this.accountEditingName = "";
      this.refreshAccounts();
    },
    async refreshAccounts() {
      try {
        this.applyAccountResult(await window.fgo.listAccounts());
      } catch (e) {
        this.accountError = e.message || String(e);
      }
    },
    /** 真正执行切换（无并发锁，供内部复用） */
    async activateAccount(id) {
      this.accountError = "";
      const res = await window.fgo.setActiveAccount(id);
      this.applyAccountResult(res);
      await this.loadActiveAccountData();
      // 结果属于上一个账号，清掉避免误读
      this.results = [];
      this.compareSelectedRanks = [];
      this.simpleExcludedServants = [];
      this.expandedResult = null;
      this.lastSearchStats = null;
      this.currentPage = 1;
    },
    async switchAccount(id) {
      const target = Number(id);
      if (!target || target === this.activeAccountId || this.accountBusy) return;
      this.accountBusy = true;
      try {
        await this.activateAccount(target);
      } catch (e) {
        this.accountError = e.message || String(e);
      } finally {
        this.accountBusy = false;
      }
    },
    async loadActiveAccountData() {
      const [userBox, exclusions] = await Promise.all([
        window.fgo.getUserBox(this.activeAccountId),
        window.fgo.getExclusions(this.activeAccountId),
      ]);
      this.applyBoxRows(userBox);
      this.excludedServants = (exclusions && exclusions.servants) || [];
      this.excludedCrafts = (exclusions && exclusions.crafts) || [];
    },
    async createAccount() {
      if (this.accountBusy) return;
      this.accountBusy = true;
      this.accountError = "";
      try {
        const res = await window.fgo.createAccount({
          name: this.newAccountName,
          copyFromId: this.newAccountCopyFromCurrent ? this.activeAccountId : null,
        });
        this.newAccountName = "";
        this.newAccountCopyFromCurrent = false;
        this.applyAccountResult(res);
        if (res && res.id) await this.activateAccount(res.id);
        await this.refreshAccounts();
      } catch (e) {
        this.accountError = e.message || String(e);
      } finally {
        this.accountBusy = false;
      }
    },
    startRenameAccount(a) {
      this.accountEditingId = a.id;
      this.accountEditingName = a.name;
      this.accountError = "";
    },
    cancelRenameAccount() {
      this.accountEditingId = null;
      this.accountEditingName = "";
    },
    async renameAccount(a) {
      const name = String(this.accountEditingName || "").trim();
      if (!name) {
        this.accountError = "账号名称不能为空";
        return;
      }
      try {
        this.applyAccountResult(await window.fgo.renameAccount({ id: a.id, name }));
        this.accountEditingId = null;
        this.accountEditingName = "";
        await this.refreshAccounts();
      } catch (e) {
        this.accountError = e.message || String(e);
      }
    },
    async duplicateAccount(a) {
      if (this.accountBusy) return;
      this.accountBusy = true;
      this.accountError = "";
      try {
        this.applyAccountResult(await window.fgo.duplicateAccount({ id: a.id }));
        await this.refreshAccounts();
      } catch (e) {
        this.accountError = e.message || String(e);
      } finally {
        this.accountBusy = false;
      }
    },
    async removeAccount(a) {
      if (this.accounts.length <= 1) {
        this.accountError = "至少保留一个账号";
        return;
      }
      if (!confirm(`删除账号「${a.name}」及其 Box 与排除列表？此操作不可恢复。`)) return;
      if (this.accountBusy) return;
      this.accountBusy = true;
      this.accountError = "";
      try {
        const wasActive = a.id === this.activeAccountId;
        this.applyAccountResult(await window.fgo.deleteAccount(a.id));
        if (wasActive) await this.loadActiveAccountData();
        await this.refreshAccounts();
      } catch (e) {
        this.accountError = e.message || String(e);
      } finally {
        this.accountBusy = false;
      }
    },
    async persistBox() {
      if (this.accountBusy) return;
      const entries = this.servants
        .filter((s) => this.box[s.id] && this.box[s.id].checked)
        .map((s) => ({
          servantId: s.id,
          stage: this.box[s.id].stage,
          isMaxBond: this.box[s.id].maxBond ? 1 : 0,
          bondSwitch1: this.box[s.id].switch1 ? 1 : 0,
          bondSwitch2: this.box[s.id].switch2 ? 1 : 0,
          personalBonus: Number(this.box[s.id].personalBonus || 0),
          auraBonus: Number(this.box[s.id].auraBonus || 0),
          bondRank: Number(this.box[s.id].bondRank || 0),
          bondMaxRank: Number(this.box[s.id].bondMaxRank || 0),
          costOverride:
            this.box[s.id].costOverride === null || this.box[s.id].costOverride === undefined
              ? null
              : Number(this.box[s.id].costOverride),
        }));
      try { await window.fgo.saveUserBox(plainClone(entries), this.activeAccountId); } catch (_) { /* ignore */ }
      this.refreshAccounts();
    },
    /**
     * 三个牵绊标记的**权威来源**（2026-10-14 按游戏规则重定，官方口径见预告知）：
     *   · 全队 25% ⇐ 牵绊 Lv ≥ **15**（与是否满绊无关；但引擎要求"满绊 ∧ 开关1"才给，
     *     所以这里 maxBond 与 switch1 一起为真）
     *   · 自身收益 ⇐ 等级 < 当前上限（还能继续涨，例如 15/16）
     *   · 自身记 0 ⇐ 等级 ≥ 当前上限
     * 等级没填过（老数据 / 纯手勾）⇒ 原样沿用用户勾的那三个标记，不猜。
     * 「计算设置 → 视为非满绊」打开时：全员强制"自身参与收益"（25% 不受影响）。
     */
    bondFlagsFor(b) {
      const rank = Number((b && b.bondRank) || 0);
      const max = Number((b && b.bondMaxRank) || 0);
      let maxBond;
      let switch1;
      let switch2;
      if (rank > 0 && max > 0) {
        const atCap = rank >= max;
        switch1 = rank >= 15;
        switch2 = !atCap;
        maxBond = switch1 || atCap;
      } else {
        maxBond = !!(b && b.maxBond);
        switch1 = !!(b && b.switch1);
        switch2 = !!(b && b.switch2);
      }
      // 防御：这个方法也会被"同分替补重算"这类轻量路径调用，resultSettings 不一定挂得上
      if (this.resultSettings && this.resultSettings.ignoreMaxBond) switch2 = true;
      return { maxBond, switch1, switch2 };
    },
    /** 把按等级推导出来的标记写回 Box（让界面上的"绊"角标、筛选、发送内容三者一致）。 */
    syncBondFlags() {
      let changed = 0;
      for (const id of Object.keys(this.box || {})) {
        const b = this.box[id];
        if (!b) continue;
        const rank = Number(b.bondRank || 0);
        const max = Number(b.bondMaxRank || 0);
        if (!(rank > 0 && max > 0)) continue;   // 等级未知 ⇒ 不动用户手勾
        const f = this.bondFlagsFor({ ...b, bondRank: rank, bondMaxRank: max });
        const want = { maxBond: f.maxBond, switch1: f.switch1, switch2: f.switch2 };
        if (b.maxBond !== want.maxBond || b.switch1 !== want.switch1 || b.switch2 !== want.switch2) {
          b.maxBond = want.maxBond;
          b.switch1 = want.switch1;
          b.switch2 = want.switch2;
          changed += 1;
        }
      }
      return changed;
    },
    /** 该从者的三个标记是否由牵绊等级自动判定（等级与上限都填了）。 */
    bondFlagsAuto(id) {
      const b = this.box && this.box[id];
      if (!b) return false;
      return Number(b.bondRank || 0) > 0 && Number(b.bondMaxRank || 0) > 0;
    },
    toggleOwned(id) {
      if (this.dragClickSuppressed()) return;
      const b = this.box[id];
      b.checked = !b.checked;
      if (!b.checked) {
        b.maxBond = false;
        b.switch1 = false;
        b.switch2 = false;
        // 如果队伍里已使用该从者，自动移除
        for (const slot of this.slots) {
          if (slot.servantId === id) { slot.servantId = null; slot.craftId = null; slot.secondCraftId = null; }
        }
      }
      this.persistBox();
    },
    toggleMaxBond(id) {
      const b = this.box[id];
      const wasSwitch1 = !!b.switch1;
      b.maxBond = !b.maxBond;
      if (!b.maxBond) {
        // 取消满绊时，25%全队加成与自身收益开关也应清掉；
        // 若已有/能推断出上限，把当前等级降为“差一级满”
        const max = Number(b.bondMaxRank || 0) || (wasSwitch1 ? 15 : 10);
        const rank = Number(b.bondRank || 0) || max;
        b.bondMaxRank = max;
        b.bondRank = Math.max(0, rank >= max ? max - 1 : rank);
        b.switch1 = false;
        b.switch2 = false;
      } else {
        // 满绊标记与25%全队加成分开：勾选满绊不再自动勾选25%
        const max = Number(b.bondMaxRank || 0) || (wasSwitch1 ? 15 : 10);
        b.bondMaxRank = max;
        b.bondRank = max;
        b.switch2 = false;
      }
      this.persistBox();
    },
    toggleSwitch1(id) {
      const b = this.box[id];
      if (!b.maxBond) {
        alert("请先标记满绊，再启用25%全队加成");
        return;
      }
      b.switch1 = !b.switch1;
      if (b.switch1) {
        // 25% 全队加成意味着达到 15 级及以上的当前上限
        const max = Math.max(15, Number(b.bondMaxRank || 0) || 15);
        b.bondMaxRank = max;
        b.bondRank = Math.max(15, Number(b.bondRank || 0) || 15);
      }
      if (!b.switch1) b.switch2 = false;
      this.persistBox();
    },
    setBondRank(id, val) {
      const b = this.box[id];
      if (!b) return;
      let rank = Math.max(0, Math.floor(Number(val) || 0));
      let max = Number(b.bondMaxRank || 0);
      if (max <= 0 && rank > 0) max = Math.max(rank, b.maxBond ? (b.switch1 ? 15 : 10) : 10);
      if (max > 0 && rank > max) rank = max;
      b.bondRank = rank;
      b.bondMaxRank = max;
      if (max > 0 && rank >= max) b.maxBond = true;
      else if (max > 0 && rank < max) {
        b.maxBond = false;
        b.switch1 = false;
        b.switch2 = false;
      }
      if (b.maxBond && rank >= 15) b.switch1 = true;
      else if (rank < 15) b.switch1 = false;
      // 等级填了 ⇒ 三个标记一律按规则推导（官方口径：25% 只看 Lv≥15；自身收益看是否达上限）
      const f = this.bondFlagsFor(b);
      b.maxBond = f.maxBond;
      b.switch1 = f.switch1;
      b.switch2 = f.switch2;
      this.persistBox();
    },
    setBondMaxRank(id, val) {
      const b = this.box[id];
      if (!b) return;
      let max = Math.max(0, Math.floor(Number(val) || 0));
      if (max <= 0) {
        max = b.maxBond ? (b.switch1 ? 15 : 10) : Math.max(10, Number(b.bondRank || 0));
      }
      let rank = Number(b.bondRank || 0);
      if (max > 0 && rank > max) rank = max;
      b.bondRank = rank;
      b.bondMaxRank = max;
      if (max > 0 && rank >= max) b.maxBond = true;
      else if (max > 0 && rank < max) {
        b.maxBond = false;
        b.switch1 = false;
        b.switch2 = false;
      }
      if (b.maxBond && rank >= 15) b.switch1 = true;
      else if (rank < 15) b.switch1 = false;
      const f = this.bondFlagsFor(b);
      b.maxBond = f.maxBond;
      b.switch1 = f.switch1;
      b.switch2 = f.switch2;
      this.persistBox();
    },
    toggleSwitch2(id) {
      this.box[id].switch2 = !this.box[id].switch2;
      this.persistBox();
    },
    setStage(id, stage) {
      this.box[id].stage = stage;
      this.persistBox();
    },
    setPersonal(id, val) {
      this.box[id].personalBonus = Number(val || 0);
      this.persistBox();
    },
    setAura(id, val) {
      this.box[id].auraBonus = Number(val || 0);
      this.persistBox();
    },
    /** 玛修的 Cost 覆盖：0（游戏里就是 0）或 16（按 16 算） */
    setCostOverride(id, val) {
      if (!this.box[id]) return;
      const empty = val === "" || val === null || val === undefined;
      this.box[id].costOverride = empty ? null : Number(val);
      this.persistBox();
    },
    toggleBatchSelect(id) {
      if (this.dragClickSuppressed()) return;
      if (this.batchSelectedServants.includes(id)) {
        this.batchSelectedServants = this.batchSelectedServants.filter((x) => x !== id);
      } else {
        this.batchSelectedServants.push(id);
      }
    },
    selectAllOwned() {
      this.batchSelectedServants = this.ownedServants.map((s) => s.id);
    },
    applyBatchBonus() {
      const selected = this.servants.filter((s) => this.batchSelectedServants.includes(s.id) && this.box[s.id] && this.box[s.id].checked);
      if (!selected.length) { alert("请先选择要批量设置的从者"); return; }
      selected.forEach((s) => { this.box[s.id].personalBonus = Number(this.batchBonus || 0); });
      this.persistBox();
      alert(`已为 ${selected.length} 位从者批量设置个人加成`);
      this.batchModalVisible = false;
    },
    async openBatchModal() {
      this.batchModalVisible = true;
      this.batchSelectedServants = this.ownedServants.map((s) => s.id);
      this.batchImportMessage = "";
      try {
        this.eventBondBonuses = await window.fgo.getEventBondBonuses();
      } catch (_) {
        this.eventBondBonuses = [];
      }
      if (this.selectedEventId && !this.eventBondEvents.some((e) => e.eventId === Number(this.selectedEventId))) {
        this.selectedEventId = null;
      }
    },
    clearAllPersonalBonus() {
      this.servants.forEach((s) => {
        if (this.box[s.id]) {
          this.box[s.id].personalBonus = 0;
          this.box[s.id].auraBonus = 0;
        }
      });
    },
    async importEventBonus() {
      const event = this.eventBondEvents.find((e) => e.eventId === Number(this.selectedEventId));
      if (!event) {
        alert("请先选择一个活动");
        return;
      }
      this.clearAllPersonalBonus();
      for (const rec of event.bonuses || []) {
        const pct = Number(rec.bonusPercent || 0);
        const scope = rec.scope || "self";
        const applyServant = (sid) => {
          const b = this.box[Number(sid)];
          if (!b || !b.checked) return;
          if (scope === "team") b.auraBonus = pct;
          else b.personalBonus = pct;
        };
        if (rec.allServants) {
          if (scope === "team") {
            this.ownedServants.forEach((s) => applyServant(s.id));
          } else {
            this.ownedServants.forEach((s) => applyServant(s.id));
          }
        } else {
          for (const sid of rec.servantIds || []) applyServant(sid);
        }
      }
      await this.persistBox();
      const cnt = this.ownedServants.filter(
        (s) => Number(this.box[s.id].personalBonus) > 0 || Number(this.box[s.id].auraBonus) > 0
      ).length;
      this.batchImportMessage = `已导入活动「${event.eventName}」，当前 ${cnt} 位持有从者带有加成（含光环）`;
    },
    async resetAllPersonalBonus() {
      if (!confirm("恢复默认将把所有从者个人加成与光环加成统一恢复为 0，是否继续？")) return;
      this.clearAllPersonalBonus();
      this.batchBonus = 0;
      await this.persistBox();
      this.batchImportMessage = "已恢复默认：所有从者个人/光环加成为 0";
    },
    resetBox() {
      if (!confirm("此操作将清空所有Box勾选、满绊标记、灵基阶段、个人加成设置，是否继续？")) return;
      this.servants.forEach((s) => {
        this.box[s.id] = { checked: false, stage: "fourth", maxBond: false, switch1: false, switch2: false, personalBonus: 0, auraBonus: 0, bondRank: 0, bondMaxRank: 0, costOverride: null };
      });
      this.slots = makeSlots();
      this.persistBox();
    },
    async reloadBoxFromServer() {
      const userBox = await window.fgo.getUserBox(this.activeAccountId);
      this.applyBoxRows(userBox);
    },
    async reloadAllData() {
      const [info, servants, bondCrafts, allCrafts, customCrafts, costumeNames, exclusions, eventBonuses] = await Promise.all([
        window.fgo.getAppInfo(),
        window.fgo.listServants(),
        window.fgo.listBondCrafts(),
        window.fgo.listAllCrafts(),
        window.fgo.listCustomCrafts(),
        window.fgo.getCostumeNames(),
        window.fgo.getExclusions(this.activeAccountId),
        window.fgo.getEventBondBonuses(),
      ]);
      this.info = info || this.info;
      this.serverRegion = (info && info.serverRegion) || this.serverRegion || "jp";
      this.cnUnavailableCraftIds = (info && info.cnUnavailableBondCeIds) || [];
      this.cnUnavailableServantIds = (info && info.cnUnavailableServantIds) || [];
      this.genericParticipatingCraftIds = (info && info.genericParticipatingCraftIds) || this.genericParticipatingCraftIds || [];
      this.nonParticipatingCraftIds = (info && info.nonParticipatingCraftIds) || this.nonParticipatingCraftIds || [];
      this.servants = servants || [];
      this.bondCrafts = bondCrafts || [];
      this.customCrafts = customCrafts || [];
      this.allCrafts = [...(allCrafts || []), ...(customCrafts || []).map((c) => this.customToCraft(c))];
      this.otherCrafts = (allCrafts || []).filter((c) => c.craftType === "other");
      this.costumeNames = costumeNames || {};
      this.excludedServants = (exclusions && exclusions.servants) || [];
      this.excludedCrafts = (exclusions && exclusions.crafts) || [];
      this.eventBondBonuses = eventBonuses || [];
      await this.reloadBoxFromServer();
      this.refreshAccounts();
    },
    isExcludedServant(id) {
      return this.excludedServantSet.has(Number(id));
    },
    isExcludedCraft(id) {
      return this.excludedCraftSet.has(Number(id));
    },
    async persistExclusions() {
      if (this.accountBusy) return;
      await window.fgo.saveExclusions(plainClone({
        servants: this.excludedServants,
        crafts: this.excludedCrafts,
      }), this.activeAccountId);
      this.refreshAccounts();
    },
    async toggleExcludeServant(id) {
      if (this.dragClickSuppressed()) return;
      const nid = Number(id);
      const set = this.excludedServantSet;
      if (set.has(nid)) {
        this.excludedServants = this.excludedServants.filter((x) => Number(x) !== nid);
      } else {
        this.excludedServants = [...this.excludedServants, nid];
      }
      await this.persistExclusions();
    },
    async toggleExcludeCraft(id) {
      const nid = Number(id);
      const set = this.excludedCraftSet;
      if (set.has(nid)) {
        this.excludedCrafts = this.excludedCrafts.filter((x) => Number(x) !== nid);
      } else {
        this.excludedCrafts = [...this.excludedCrafts, nid];
      }
      await this.persistExclusions();
    },
    async selectAllExclusion() {
      if (this.exclusionTab === "servant") {
        this.excludedServants = Array.from(new Set([...this.excludedServants, ...this.filteredExclusionServants.map((s) => s.id)]));
      } else {
        this.excludedCrafts = Array.from(new Set([...this.excludedCrafts, ...this.filteredExclusionCrafts.map((c) => c.id)]));
      }
      await this.persistExclusions();
    },
    async clearCurrentExclusion() {
      if (this.exclusionTab === "servant") {
        const ids = new Set(this.filteredExclusionServants.map((s) => s.id));
        this.excludedServants = this.excludedServants.filter((x) => !ids.has(Number(x)));
      } else {
        const ids = new Set(this.filteredExclusionCrafts.map((c) => c.id));
        this.excludedCrafts = this.excludedCrafts.filter((x) => !ids.has(Number(x)));
      }
      await this.persistExclusions();
    },
    triggerCaptureImport() {
      const input = this.$refs.captureInput;
      if (!input) return;
      // 安卓的系统文件选择器**只认 MIME 类型**：Capacitor 会把 accept 里的扩展名翻成 MIME，
      // 翻不出来的（.php 不在安卓的 MimeTypeMap 里）会被直接丢掉，
      // 最后只剩 text/plain + application/json 两个过滤条件；
      // 而抓包文件通常被系统认成 octet-stream → 在选择器里是灰的、点不动。
      // 所以安卓上放开过滤（*/*），让所有文件都能选；桌面端保留扩展名过滤，方便找人。
      let android = false;
      try { android = !!(this.isAndroidPlatform && this.isAndroidPlatform()); } catch (_) { android = false; }
      input.accept = android ? "*/*" : ".php,.txt,.json,application/json";
      input.click();
    },
    async onCaptureFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const result = await window.fgo.importCapture(text, this.activeAccountId);
        alert(`已导入到账号「${this.activeAccountName()}」：持有从者 ${result.servants} 位，满绊 ${result.maxBond} 位`);
        await this.reloadBoxFromServer();
        this.refreshAccounts();
      } catch (err) {
        alert("导入失败：" + (err && err.message ? err.message : String(err)));
      }
    },
    filteredBoxServants() {
      const kw = this.boxFilter.keyword.toLowerCase();
      return this.servants.filter((s) => {
        if (kw && !s.name.toLowerCase().includes(kw)) return false;
        if (!this.matchesClassFilter(s.class, this.boxFilter.class)) return false;
        if (this.boxFilter.rarity !== "all" && Number(s.rarity) !== Number(this.boxFilter.rarity)) return false;
        const b = this.box[s.id] || {};
        if (this.boxFilter.owned === "owned" && !b.checked) return false;
        if (this.boxFilter.owned === "notOwned" && b.checked) return false;
        if (this.boxFilter.maxBond === "max" && !b.maxBond) return false;
        if (this.boxFilter.maxBond === "notMax" && b.maxBond) return false;
        return true;
      });
    },

    // ---------- 槽位选择 ----------
    openOverlay(slotIndex, target, craftIndex = 0) {
      this.overlay = {
        visible: true,
        slotIndex,
        target,
        craftIndex,
        keyword: "",
        classFilter: "all",
        rarityFilter: "all",
        ownedOnly: true,
        craftType: "bond",
      };
    },
    closeOverlay() { this.overlay.visible = false; },
    chooseServant(slotIndex, servantId) {
      const target = this.slots[slotIndex];
      const existing = this.slots.findIndex((s, i) => i !== slotIndex && s.servantId === servantId);
      // 助战位可与自由/其他位置重复（和助战礼装规则一致）；普通玩家位之间仍不允许重复。
      const allowDuplicate = existing >= 0 && (target.isSupport || this.slots[existing].isSupport);
      if (existing >= 0 && !allowDuplicate) {
        if (!confirm("该从者已在其他槽位，是否移回当前槽位？")) return;
        this.slots[existing].servantId = null;
        this.slots[existing].craftId = null;
        this.slots[existing].secondCraftId = null;
        this.slots[existing].stage = null;
      }
      const slot = this.slots[slotIndex];
      slot.servantId = servantId;
      slot.stage = null;
      // 用户主动填写 => 固定；如果当前不是助战，就作为固定从者
      this.closeOverlay();
    },
    isRepeatableCraft(craftId) {
      // 合成礼装均可重复：通用5%（-10）、无礼装（0）、其他礼装（-1~-5）
      if (Number(craftId) <= 0) return true;
      const c = this.craftById(craftId);
      return !!(c && c.repeatable);
    },
    isSupportOnlyCraft(craftId) {
      const c = this.craftById(craftId);
      return !!(c && Number(c.supportBonus || 0) > 0);
    },
    chooseCraft(slotIndex, craftId, craftIndex = 0) {
      const target = this.slots[slotIndex];
      if (!target.isSupport && this.isSupportOnlyCraft(craftId)) {
        alert("迦勒底午茶时光等助战加成礼装只能放在助战位");
        return;
      }
      const otherInSlot = craftIndex === 1 ? target.craftId : target.secondCraftId;
      if (otherInSlot !== null && otherInSlot !== undefined && otherInSlot === craftId && !this.isRepeatableCraft(craftId)) {
        alert("同一冠位从者不能重复装备同一张非通用礼装");
        return;
      }
      const existing = this.slots.findIndex((s, i) => {
        if (i === slotIndex) return false;
        return s.craftId === craftId || (s.isCrown && s.secondCraftId === craftId);
      });
      // 助战位可与任意位置重复；“通用5%”在玩家位之间也可重复。
      const allowDuplicate =
        (existing >= 0 && (target.isSupport || this.slots[existing].isSupport)) ||
        this.isRepeatableCraft(craftId);
      if (existing >= 0 && !allowDuplicate) {
        if (!confirm("该礼装已在其他槽位，是否移回当前槽位？")) return;
        this.slots[existing].craftId = null;
        this.slots[existing].secondCraftId = null;
      }
      if (craftIndex === 1) this.slots[slotIndex].secondCraftId = craftId;
      else this.slots[slotIndex].craftId = craftId;
      this.closeOverlay();
    },
    clearSlotServant(i) {
      this.slots[i].servantId = null;
      this.slots[i].craftId = null;
      this.slots[i].secondCraftId = null;
      this.slots[i].isSupport = false;
      this.slots[i].stage = null;
    },
    clearSlotCraft(i, craftIndex = 0) {
      if (craftIndex === 1) this.slots[i].secondCraftId = null;
      else this.slots[i].craftId = null;
    },
    toggleCrown(i) {
      const slot = this.slots[i];
      if (!slot) return;
      slot.isCrown = !slot.isCrown;
      if (!slot.isCrown) slot.secondCraftId = null;
    },
    switchMode(mode) {
      if (this.mode === mode) return;
      this.mode = mode;
      if (mode !== "crown") {
        // 普通模式不展示/不计算第二礼装位，但不清除冠位标记，便于切回后恢复
        this.results = [];
      } else {
        this.crownClass = this.crownClass || "all";
        this.results = [];
      }
      this.currentPage = 1;
    },
    toggleSupport(i) {
      // 助战只允许一个
      if (this.slots[i].isSupport) {
        this.slots[i].isSupport = false;
      } else {
        if (this.supportCount >= 1) {
          alert("助战位只能设置一个");
          return;
        }
        this.slots[i].isSupport = true;
      }
    },

    // ---------- 右键菜单 ----------
    openContextMenu(e, slotIndex, target, craftIndex = 0) {
      e.preventDefault();
      this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, slotIndex, target, craftIndex };
    },
    closeContextMenu() { this.contextMenu.visible = false; this.settingsMenuOpen = false; },
    ctxSupport() {
      const i = this.contextMenu.slotIndex;
      if (i !== null) this.toggleSupport(i);
      this.closeContextMenu();
    },
    ctxCrown() {
      const i = this.contextMenu.slotIndex;
      if (i !== null) this.toggleCrown(i);
      this.closeContextMenu();
    },
    ctxClear() {
      const { slotIndex, target, craftIndex } = this.contextMenu;
      if (slotIndex !== null) {
        if (target === "servant") this.clearSlotServant(slotIndex);
        else this.clearSlotCraft(slotIndex, craftIndex || 0);
      }
      this.closeContextMenu();
    },
    openBoxContext(e, servant) {
      e.preventDefault();
      this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, slotIndex: null, target: "box", servantId: servant.id };
    },
    openOverlayServantContext(e, servant) {
      e.preventDefault();
      this.contextMenu = {
        visible: true,
        x: e.clientX,
        y: e.clientY,
        slotIndex: this.overlay.slotIndex,
        target: "overlay-servant",
        servantId: servant.id,
      };
    },
    ctxOverlayServantDetail() {
      const sid = Number(this.contextMenu.servantId);
      this.closeContextMenu();
      this.overlay.visible = false;
      if (sid && this.box[sid]) {
        this.openServantDetail(sid, null);
      } else {
        const s = this.servantMap[sid];
        alert(s ? `「${s.name}」不在你的 Box 中，无法设置` : "未找到该从者");
      }
    },
    ctxOverlayServantAttr() {
      const sid = Number(this.contextMenu.servantId);
      this.closeContextMenu();
      this.overlay.visible = false;
      if (sid) this.openServantAttr(sid);
    },
    ctxDetail() {
      const { slotIndex, servantId } = this.contextMenu;
      const sid = servantId !== undefined ? servantId : (slotIndex !== null ? this.slots[slotIndex].servantId : null);
      const detailSlotIndex = this.contextMenu.target === "servant" ? slotIndex : null;
      this.closeContextMenu();
      if (sid !== null) this.openServantDetail(sid, detailSlotIndex);
    },
    ctxReplace() {
      const { slotIndex, target, craftIndex } = this.contextMenu;
      this.closeContextMenu();
      if (slotIndex !== null) this.openOverlay(slotIndex, target, target === "craft" ? (craftIndex || 0) : 0);
    },
    openResultContext(e, result, member, kind, craftIndex = 0) {
      e.preventDefault();
      this.contextMenu = {
        visible: true,
        x: e.clientX,
        y: e.clientY,
        slotIndex: null,
        target: kind === "craft" ? "result-craft" : "result-servant",
        result,
        member,
        craftIndex,
      };
    },
    ctxSimpleExclude() {
      const m = this.contextMenu.member;
      this.closeContextMenu();
      if (m) this.toggleSimpleExclude(m.servantId);
    },
    ctxResultInfo() {
      const { result, member, target, craftIndex } = this.contextMenu;
      this.closeContextMenu();
      if (result && member) this.openResultInfo(result, member, target === "result-craft" ? "craft" : "servant", craftIndex || 0);
    },
    toggleSimpleExclude(id) {
      const n = Number(id);
      const list = this.simpleExcludedServants;
      this.simpleExcludedServants = list.includes(n) ? list.filter((x) => x !== n) : [...list, n];
      this.currentPage = 1;
    },
    isSimpleExcluded(id) {
      return this.simpleExcludedSet.has(Number(id));
    },
    goPage(p) {
      this.currentPage = Math.min(Math.max(1, Number(p) || 1), this.totalPages);
    },
    traitLabel(key) {
      return TRAIT_LABELS[key] || key;
    },
    traitGroupsText(c) {
      try {
        const groups = JSON.parse(c.triggerTraitsJson || "[]");
        return groups
          .map((g) => (Array.isArray(g) ? g.map((t) => this.traitLabel(t)).join(" + ") : ""))
          .filter(Boolean)
          .join(" 或 ") || "无";
      } catch (_) {
        return "无";
      }
    },
    activeTraitKeys(result, member, traits) {
      const traitSet = new Set(traits || []);
      const active = new Set();
      const seenCraft = new Set();
      for (const m of result.team || []) {
        const craftIds = [m.craftId];
        if (m.secondCraftId !== null && m.secondCraftId !== undefined) craftIds.push(m.secondCraftId);
        for (const cid of craftIds) {
          const c = this.craftById(cid);
          if (!c || seenCraft.has(c.id) || c.bonusType !== "trait") continue;
          seenCraft.add(c.id);
          let groups = [];
          try {
            groups = JSON.parse(c.triggerTraitsJson || "[]");
          } catch (_) { /* ignore */ }
          for (const g of groups) {
            if (Array.isArray(g) && g.length && g.every((t) => traitSet.has(t))) {
              for (const t of g) active.add(t);
            }
          }
        }
      }
      return active;
    },
    async openResultInfo(result, member, kind, craftIndex = 0) {
      if (kind === "craft") {
        const cid = craftIndex === 1 ? member.secondCraftId : member.craftId;
        const c = this.craftById(cid);
        if (!c) return;
        this.resultInfo = {
          visible: true,
          mode: "craft",
          title: c.name || "礼装",
          subtitle: `${c.rarity || 0}★ / ${craftIndex === 1 ? '冠位第二礼装位 · 计算时 Cost 0' : 'Cost ' + (c.cost || 0)}`,
          rows: [
            { label: "类型", value: c.craftType === "bond" ? "牵绊加成礼装" : "其他礼装" },
            { label: "效果", value: c.detail || c.name || "无特殊效果" },
            { label: "触发属性", value: this.traitGroupsText(c) },
          ],
        };
        return;
      }
      const sname = member.name || this.servantMap[member.servantId]?.name || "从者";
      const stageLabel = String(member.stage || "fourth").startsWith("costume_")
        ? (this.costumeNames[String(member.stage.split("_")[1])] ? "灵衣：" + this.costumeNames[String(member.stage.split("_")[1])] : "灵衣")
        : this.stageLabel(member.stage || "fourth");
      this.resultInfo = {
        visible: true,
        mode: "servant",
        title: sname,
        subtitle: `${stageLabel}（推荐方案 #${result.rank}）`,
        rows: [],
      };
      try {
        const traits = await window.fgo.getStageTraits(member.servantId, member.stage || "fourth", this.serverRegion);
        const active = this.activeTraitKeys(result, member, traits || []);
        this.resultInfo.rows = (traits || []).map((t) => ({ label: t, active: active.has(t) }));
      } catch (e) {
        this.resultInfo.rows = [{ label: "读取失败", active: false }];
      }
    },
    closeResultInfo() {
      this.resultInfo.visible = false;
    },

    // ---------- 队伍 ----------
    resetTeam() {
      if (!confirm("此操作将清空所有格子、固定状态、助战状态、冠位标记，并恢复Cost上限/策略/基础数值/模式，是否继续？")) return;
      this.slots = makeSlots();
      this.costLimit = 116;
      this.strategy = "total_max";
      this.qualityMode = "balanced";
      this.targetServantId = null;
      this.targetServantKeyword = "";
      this.baseBond = 0;
      this.sortMode = "multiplier";
      this.mode = "normal";
      this.crownClass = "all";
      this.results = [];
    },
    randomFillFree() {
      const usedIds = new Set(this.slots.filter((s) => s.servantId !== null).map((s) => s.servantId));
      const usedCraftIds = new Set(
        this.slots
          .filter((s) => !s.isSupport)
          .flatMap((s) => [s.craftId, s.secondCraftId])
          .filter((x) => x !== null && x !== undefined)
      );
      const crownGroup = this.mode === "crown" ? this.crownClass : "all";
      const candidates = this.ownedServants.filter((s) => !usedIds.has(s.id) && this.matchesCrownClassFilter(s.class, crownGroup));
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].servantId === null && !this.slots[i].isSupport) {
          if (!candidates.length) break;
          const idx = Math.floor(Math.random() * candidates.length);
          const s = candidates.splice(idx, 1)[0];
          this.slots[i].servantId = s.id;
          const availableCrafts = this.meaningfulBondCrafts.filter(
            (c) =>
              !this.isSupportOnlyCraft(c.id) &&
              this.isCraftParticipating(c) &&
              (this.isRepeatableCraft(c.id) || !usedCraftIds.has(c.id))
          );
          const c = availableCrafts.length ? availableCrafts[Math.floor(Math.random() * availableCrafts.length)] : null;
          this.slots[i].craftId = c ? c.id : null;
          if (c && !this.isRepeatableCraft(c.id)) usedCraftIds.add(c.id);
        }
      }
    },

    // ---------- 队伍预设 ----------
    /** 新预设默认名 = 队伍里从者的名字（含助战，最多 6 个，`_` 连接）；一个都没选就走兜底名。 */
    defaultPresetName() {
      const names = [];
      (this.slots || []).forEach((slot) => {
        if (slot.servantId === null || slot.servantId === undefined) return;
        const s = this.servantMap && this.servantMap[slot.servantId];
        if (s && s.name) names.push(s.name);
      });
      if (!names.length) return this.nextEmptyPresetName();
      return names.slice(0, 6).join("_");
    },
    /** 没选从者时的兜底名：新预设1 / 新预设2 …（跳过已被占用的） */
    nextEmptyPresetName() {
      const used = new Set((this.presets || []).map((p) => String((p && p.name) || "")));
      for (let i = 1; i < 1000; i += 1) {
        if (!used.has("新预设" + i)) return "新预设" + i;
      }
      return "新预设";
    },
    /** 预设列表里的时间标签：MM-DD HH:MM（拿不到就空） */
    presetDateText(preset) {
      const raw = String((preset && preset.createdAt) || "");
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
      return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : "";
    },
    /** 预设列表里的模式/固定位标签 */
    presetFixedText(preset) {
      if (!preset) return "";
      const parts = [];
      if (preset.mode === "crown") parts.push("戴冠战");
      const n = (preset.fixedServants || []).length;
      if (n > 0) parts.push("固定 " + n);
      return parts.join(" · ");
    },
    saveTeam() {
      this.presetName = this.defaultPresetName();
      this.presetSaveVisible = true;
    },
    async confirmSavePreset() {
      const name = (this.presetName || "").trim();
      if (!name) {
        alert("请输入预设名称");
        return;
      }
      this.presetSaveVisible = false;
      const fixedServants = [];
      const fixedCrafts = [];
      const crownPositions = [];
      let supportPosition = null;
      let support = { servantId: null, craftId: null, secondCraftId: null };
      this.slots.forEach((slot, i) => {
        const pos = this.slotPosition(i);
        if (this.mode === "crown" && slot.isCrown) crownPositions.push(pos);
        if (slot.isSupport) {
          supportPosition = pos;
          support = {
            servantId: slot.servantId !== null ? slot.servantId : null,
            craftId: slot.craftId !== null && slot.craftId !== undefined ? slot.craftId : null,
            secondCraftId: this.mode === "crown" && slot.isCrown && slot.secondCraftId !== null && slot.secondCraftId !== undefined ? slot.secondCraftId : null,
          };
          return;
        }
        if (slot.servantId !== null) {
          const fixed = { position: pos, servantId: slot.servantId };
          if (slot.stage) fixed.stage = slot.stage;
          fixedServants.push(fixed);
        }
        if (slot.craftId !== null) {
          const craft = this.craftById(slot.craftId);
          fixedCrafts.push({ position: pos, craftId: slot.craftId, type: craft && craft.craftType === "bond" ? "bond" : "other", slot: 0 });
        }
        if (this.mode === "crown" && slot.isCrown && slot.secondCraftId !== null && slot.secondCraftId !== undefined) {
          const craft = this.craftById(slot.secondCraftId);
          fixedCrafts.push({ position: pos, craftId: slot.secondCraftId, type: craft && craft.craftType === "bond" ? "bond" : "other", slot: 1 });
        }
      });
      const team = {
        name,
        mode: this.mode,
        crownClass: this.crownClass,
        crownPositions,
        baseBond: Number(this.baseBond || 0),
        sortMode: this.sortMode === "points" ? "points" : "multiplier",
        fixedServants,
        fixedCrafts,
        supportId: support.servantId,
        supportCraftId: support.craftId,
        supportSecondCraftId: support.secondCraftId,
        supportPosition,
        costLimit: this.costLimit,
        strategy: this.strategy,
        qualityMode: this.qualityMode,
        neighborhood: this.neighborhood === "off" || this.neighborhood === "deep"
          ? this.neighborhood
          : "standard",
      };
      try {
        // 「同时保存本次结果」：预设照常存；勾了就额外挂一份结果（下次打开不用重算）
        if (this.presetSaveWithResult && this.lastResultSnapshot) {
          team.result = {
            results: this.lastResultSnapshot.results || [],
            stats: this.lastResultSnapshot.stats || null,
          };
          team.request = this.lastResultSnapshot.payload || null;
          team.dataRevision = this.lastResultSnapshot.dataRevision || null;
        }
        await window.fgo.saveUserTeam(plainClone(team));
        this.presets = await window.fgo.listUserTeams();
        alert(team.result ? "队伍与本次结果已保存" : "队伍已保存");
      } catch (err) {
        alert("保存失败：" + (err && err.message ? err.message : String(err)));
        this.presetSaveVisible = true;
      }
    },
    async loadPreset(preset) {
      const fixedServants = preset.fixedServants || [];
      const fixedCrafts = preset.fixedCrafts || [];
      const support = { servantId: preset.supportId, craftId: preset.supportCraftId, secondCraftId: preset.supportSecondCraftId };
      const supportPosition = preset.supportPosition || null;
      const crownPositions = new Set((preset.crownPositions || []).map(String));
      const fresh = makeSlots();
      // 清空默认助战标记，待下面按预设精确重建助战位
      fresh.forEach((s) => { s.isSupport = false; });
      POSITION_KEYS.forEach((pos, i) => {
        fresh[i].isCrown = crownPositions.has(pos);
      });
      fixedServants.forEach((f) => {
        const idx = POSITION_KEYS.indexOf(f.position);
        if (idx >= 0) {
          fresh[idx].servantId = f.servantId;
          fresh[idx].stage = f.stage || null;
          fresh[idx].isSupport = false;
        }
      });
      fixedCrafts.forEach((f) => {
        const idx = POSITION_KEYS.indexOf(f.position);
        if (idx >= 0) {
          if (Number(f.slot || 0) === 1) fresh[idx].secondCraftId = f.craftId;
          else fresh[idx].craftId = f.craftId;
        }
      });
      // 旧预设没有 supportPosition 时采用兼容策略：尽量放回默认助战位，
      // 若默认位已被固定占用则放到第一个空闲位。
      let idx = -1;
      if (supportPosition && POSITION_KEYS.includes(supportPosition)) {
        idx = POSITION_KEYS.indexOf(supportPosition);
      } else if (support.servantId) {
        const used = fresh.findIndex((s) => s.servantId === support.servantId);
        idx = used >= 0 ? used : fresh.findIndex((s) => s.servantId === null && !s.isSupport);
      } else {
        idx = fresh.findIndex((s) => s.servantId === null && !s.isSupport);
      }
      if (idx < 0) idx = fresh.findIndex((s) => !s.isSupport);
      if (idx < 0) idx = 0;
      if (support.servantId) fresh[idx].servantId = support.servantId;
      if (support.craftId !== null && support.craftId !== undefined) fresh[idx].craftId = support.craftId;
      if (support.secondCraftId !== null && support.secondCraftId !== undefined) fresh[idx].secondCraftId = support.secondCraftId;
      fresh[idx].isSupport = true;
      this.slots = fresh;
      this.costLimit = preset.costLimit || 116;
      this.strategy = preset.strategy || "total_max";
      this.qualityMode = preset.qualityMode || "balanced";
      this.neighborhood = preset.neighborhood === "off" || preset.neighborhood === "deep"
        ? preset.neighborhood
        : "standard";
      this.mode = preset.mode || "normal";
      this.crownClass = preset.crownClass || "all";
      this.baseBond = Number(preset.baseBond || 0);
      this.sortMode = preset.sortMode === "points" ? "points" : "multiplier";
      this.presetModalVisible = false;
      // 该预设挂着存档结果 ⇒ 直接显示，不重算（用户 2026-10-14 的需求）；
      // 没挂结果就把结果区清空 —— 否则屏幕上还留着上一次的结果，看着像这个预设算过
      // （用户 2026-10-18 指出）
      const shown = preset.hasResult ? await this.showSavedResult(preset) : false;
      if (!shown) this.clearResultArea();
    },
    /** 取某预设挂着的存档结果并显示（**不调用引擎**）。返回是否真的显示了结果。 */
    async showSavedResult(preset) {
      let saved = null;
      try {
        saved = await window.fgo.getUserTeamResult(preset.id);
      } catch (err) {
        this.error = "读取存档结果失败：" + (err && err.message ? err.message : String(err));
        return false;
      }
      if (!saved || !saved.result) return false;
      const bundle = Array.isArray(saved.result) ? { results: saved.result, stats: null } : saved.result;
      const rows = bundle.results || [];
      if (!rows.length) return false;
      this.results = plainClone(rows);
      this.lastSearchStats = bundle.stats || null;
      this.lastResultSnapshot = {
        results: plainClone(rows),
        stats: plainClone(this.lastSearchStats),
        payload: saved.request || null,
        dataRevision: saved.dataRevision || null,
        clientVersion: (this.info && this.info.version) || null,
      };
      this.loadedResultInfo = {
        presetName: preset.name || "",
        savedAt: saved.savedAt || null,
        dataRevision: saved.dataRevision || null,
        stale: !!(saved.dataRevision && this.info && this.info.dataUpdatedAt
          && String(saved.dataRevision) !== String(this.info.dataUpdatedAt)),
      };
      this.currentPage = 1;
      this.expandedResult = null;
      setTimeout(() => {
        document.querySelector(".results-section")?.scrollIntoView({ behavior: "smooth" });
      }, 50);
      return true;
    },
    /**
     * 清空结果区（加载的预设没有存档结果时用）。
     * 连 lastResultSnapshot 一起清 —— 否则「同时保存本次结果」会把上一份结果偷偷挂到新预设上。
     */
    clearResultArea() {
      this.results = [];
      this.lastSearchStats = null;
      this.lastResultSnapshot = null;
      this.loadedResultInfo = null;
      this.expandedResult = null;
      this.expandedSameScore = null;
      this.sameScoreChoice = {};
      this.sameScoreExpanded = {};
      this.compareSelectedRanks = [];
      this.compareVisible = false;
      this.currentPage = 1;
    },
    /** 明确清掉"这是存档结果"的提示（点开始计算时调用）。 */
    clearLoadedResultInfo() {
      this.loadedResultInfo = null;
    },
    // ---------------- 预设改名 ----------------
    startRenamePreset(preset) {
      if (!preset || !preset.id) return;
      this.renamingPresetId = Number(preset.id);
      this.renameDraft = preset.name || "";
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector(".preset-rename-input");
        if (el) {
          el.focus();
          if (el.select) el.select();
        }
      });
    },
    cancelRenamePreset() {
      this.renamingPresetId = null;
      this.renameDraft = "";
    },
    async confirmRenamePreset(preset) {
      if (!preset || this.renamingPresetId !== Number(preset.id)) return;
      const name = String(this.renameDraft || "").trim();
      const oldName = preset.name || "";
      this.renamingPresetId = null;
      this.renameDraft = "";
      if (!name || name === oldName) return;
      try {
        await window.fgo.renameUserTeam(preset.id, name);
        this.presets = await window.fgo.listUserTeams();
        // 结果区顶部那条"从哪个预设来的"也跟着改名，别显示旧名
        if (this.loadedResultInfo && this.loadedResultInfo.presetName === oldName) {
          this.loadedResultInfo.presetName = name;
        }
      } catch (err) {
        alert("重命名失败：" + (err && err.message ? err.message : String(err)));
      }
    },
    async deletePreset(preset) {
      if (!preset || !preset.id) return;
      if (!confirm(`确定删除预设「${preset.name || "未命名"}」吗？`)) return;
      try {
        await window.fgo.deleteUserTeam(preset.id);
        this.presets = (this.presets || []).filter((p) => Number(p.id) !== Number(preset.id));
      } catch (err) {
        alert("删除失败：" + (err && err.message ? err.message : String(err)));
      }
    },

    // ---------- 自定义礼装 ----------
    openCustomManager() {
      this.customModalVisible = true;
    },
    closeCustomManager() {
      if (this.customDraft && !confirm("当前编辑尚未保存，确定关闭吗？")) return;
      this.customDraft = null;
      this.customTraitInputs = [];
      this.customModalVisible = false;
    },
    blankCustomDraft() {
      return {
        id: 0,
        name: "",
        craftType: "bond",
        cost: 12,
        rarity: 5,
        percentBonus: 0,
        flatBonus: 0,
        conditionGroups: [],
        repeatable: false,
        enabled: true,
      };
    },
    newCustomCraft() {
      this.customDraft = this.blankCustomDraft();
      this.customEditing = null;
      this.customTraitInputs = [];
    },
    editCustomCraft(item) {
      const draft = JSON.parse(JSON.stringify(item || {}));
      draft.conditionGroups = Array.isArray(draft.conditionGroups) ? draft.conditionGroups : [];
      draft.cost = Number(draft.cost || 0);
      draft.rarity = Number(draft.rarity || 0);
      draft.percentBonus = Number(draft.percentBonus || 0);
      draft.flatBonus = Number(draft.flatBonus || 0);
      draft.repeatable = !!draft.repeatable;
      draft.enabled = draft.enabled !== false;
      this.customDraft = draft;
      this.customEditing = item;
      this.customTraitInputs = draft.conditionGroups.map(() => "");
    },
    async deleteCustomCraft(item) {
      if (!item) return;
      if (!confirm(`确定删除自定义礼装「${item.name || "未命名"}」吗？`)) return;
      this.customCrafts = (this.customCrafts || []).filter((c) => Number(c.id) !== Number(item.id));
      if (this.customEditing && Number(this.customEditing.id) === Number(item.id)) {
        this.customEditing = null;
        this.customDraft = null;
        this.customTraitInputs = [];
      }
      await this.persistCustomCrafts();
    },
    async toggleCustomCraft(item) {
      if (!item) return;
      item.enabled = !item.enabled;
      await this.persistCustomCrafts();
    },
    customAddGroup() {
      if (!this.customDraft) return;
      this.customDraft.conditionGroups = this.customDraft.conditionGroups || [];
      this.customDraft.conditionGroups.push([]);
      this.customTraitInputs.push("");
    },
    customSetUnconditional() {
      if (!this.customDraft) return;
      this.customDraft.conditionGroups = [];
      this.customTraitInputs = [];
    },
    customSetConditional() {
      if (!this.customDraft) return;
      if (!this.customDraft.conditionGroups || !this.customDraft.conditionGroups.length) {
        this.customDraft.conditionGroups = [[]];
        this.customTraitInputs = [""];
      }
    },
    customCancelEdit() {
      this.customDraft = null;
      this.customTraitInputs = [];
    },
    customRemoveGroup(index) {
      if (!this.customDraft) return;
      this.customDraft.conditionGroups.splice(index, 1);
      this.customTraitInputs.splice(index, 1);
    },
    resolveCustomTrait(input) {
      const kw = String(input || "").trim().toLowerCase();
      if (!kw) return null;
      const keys = Object.keys(TRAIT_LABELS);
      let found = keys.find((k) => k.toLowerCase() === kw);
      if (!found) found = keys.find((k) => String(TRAIT_LABELS[k]).toLowerCase() === kw);
      if (!found) found = keys.find((k) => String(TRAIT_LABELS[k]).toLowerCase().includes(kw));
      return found || null;
    },
    customAddTrait(groupIndex) {
      if (!this.customDraft) return;
      const input = (this.customTraitInputs[groupIndex] || "").trim();
      const key = this.resolveCustomTrait(input);
      if (!key) {
        alert("找不到该条件，请输入或选择有效的特性名称/关键字");
        return;
      }
      const groups = this.customDraft.conditionGroups || [];
      if (!groups[groupIndex]) groups[groupIndex] = [];
      if (!groups[groupIndex].includes(key)) groups[groupIndex].push(key);
      this.customTraitInputs[groupIndex] = "";
    },
    customRemoveTrait(groupIndex, key) {
      if (!this.customDraft) return;
      const groups = this.customDraft.conditionGroups || [];
      if (groups[groupIndex]) {
        groups[groupIndex] = groups[groupIndex].filter((k) => k !== key);
        if (!groups[groupIndex].length) this.customRemoveGroup(groupIndex);
      }
    },
    async saveCustomCraft() {
      if (!this.customDraft) return;
      const name = String(this.customDraft.name || "").trim();
      if (!name) {
        alert("请输入礼装名称");
        return;
      }
      const draft = this.customDraft;
      const groups = (draft.conditionGroups || [])
        .map((g) => (Array.isArray(g) ? g.filter(Boolean) : []))
        .filter((g) => g.length);
      const item = {
        id: Number(draft.id || 0),
        name,
        craftType: draft.craftType === "other" ? "other" : "bond",
        cost: Math.max(0, Number(draft.cost || 0)),
        rarity: Math.max(0, Number(draft.rarity || 0)),
        percentBonus: Math.max(0, Number(draft.percentBonus || 0)),
        flatBonus: Math.max(0, Number(draft.flatBonus || 0)),
        conditionGroups: groups,
        repeatable: !!draft.repeatable,
        enabled: draft.enabled !== false,
      };
      if (item.id > 0) {
        const idx = this.customCrafts.findIndex((c) => Number(c.id) === Number(item.id));
        if (idx >= 0) this.customCrafts.splice(idx, 1, item);
        else this.customCrafts.push(item);
      } else {
        this.customCrafts.push(item);
      }
      await this.persistCustomCrafts();
      this.customDraft = null;
      this.customTraitInputs = [];
      this.customModalVisible = false;
    },
    async persistCustomCrafts() {
      try {
        const [builtinAll, saved] = await Promise.all([
          window.fgo.listAllCrafts(),
          window.fgo.saveCustomCrafts(plainClone(this.customCrafts || [])),
        ]);
        this.customCrafts = saved || [];
        this.allCrafts = [...(builtinAll || []), ...(saved || []).map((c) => this.customToCraft(c))];
      } catch (err) {
        alert("保存自定义礼装失败：" + (err && err.message ? err.message : String(err)));
        throw err;
      }
    },

    // ---------- 礼装参与自动搜索开关 ----------
    isGenericCraft(c) {
      if (!c) return false;
      return !!(c.isGenericCraft || GENERIC_BOND_CRAFT_IDS.includes(Number(c.id)));
    },
    isCraftParticipating(c) {
      if (!c) return false;
      const id = Number(c.id);
      // 通用礼装默认不参与，除非在 genericParticipatingCraftIds 中；
      // 其他牵绊礼装默认参与，除非在 nonParticipatingCraftIds 中。
      if (this.isGenericCraft(c)) return this.genericParticipatingSet.has(id);
      return !this.nonParticipatingCraftSet.has(id);
    },
    async toggleCraftAutoParticipation(c) {
      if (!c || c.craftType !== "bond") return;
      const id = Number(c.id);
      if (this.isGenericCraft(c)) {
        const set = new Set(this.genericParticipatingCraftIds.map(Number));
        if (set.has(id)) set.delete(id);
        else set.add(id);
        const next = Array.from(set);
        this.genericParticipatingCraftIds = next;
        try {
          this.genericParticipatingCraftIds = await window.fgo.setGenericBondParticipation(plainClone(next));
        } catch (err) {
          alert("保存通用礼装参与设置失败：" + (err && err.message ? err.message : String(err)));
        }
      } else {
        const set = new Set(this.nonParticipatingCraftIds.map(Number));
        if (set.has(id)) set.delete(id);
        else set.add(id);
        const next = Array.from(set);
        this.nonParticipatingCraftIds = next;
        try {
          this.nonParticipatingCraftIds = await window.fgo.setNonParticipatingCraftIds(plainClone(next));
        } catch (err) {
          alert("保存礼装参与设置失败：" + (err && err.message ? err.message : String(err)));
        }
      }
    },

    // ---------- 计算 ----------
    buildPayload() {
      const box = this.ownedServants.map((s) => {
        const b = this.box[s.id];
        const f = this.bondFlagsFor(b);          // 按牵绊等级推导（规则见 bondFlagsFor）
        return {
          id: s.id,
          stage: b.stage,
          maxBond: f.maxBond,
          bondSwitch1: f.switch1,
          bondSwitch2: f.switch2,
          personalBonus: Number(b.personalBonus || 0) / 100,
          auraBonus: Number(b.auraBonus || 0) / 100,
          // 玛修 Cost 覆盖（0/16）：没设置就不传，引擎按资料库里的 Cost 算
          costOverride: b.costOverride === null || b.costOverride === undefined ? null : Number(b.costOverride),
        };
      });
      const fixedServants = [];
      const fixedCrafts = [];
      const crownPositions = [];
      let support = {};
      this.slots.forEach((slot, i) => {
        const pos = this.slotPosition(i);
        if (this.mode === "crown" && slot.isCrown) crownPositions.push(pos);
        if (slot.isSupport) {
          support = {
            position: pos,
            servantId: slot.servantId || null,
            craftId: slot.craftId === null ? null : slot.craftId,
            secondCraftId: this.mode === "crown" && slot.isCrown && slot.secondCraftId !== null && slot.secondCraftId !== undefined ? slot.secondCraftId : null,
          };
          return;
        }
        if (slot.servantId !== null) {
          const fixed = { position: pos, servantId: slot.servantId };
          if (slot.stage) fixed.stage = slot.stage;
          fixedServants.push(fixed);
        }
        if (slot.craftId !== null) {
          const craft = this.craftById(slot.craftId);
          fixedCrafts.push({ position: pos, craftId: slot.craftId, type: craft && craft.craftType === "bond" ? "bond" : "other", slot: 0 });
        }
        if (this.mode === "crown" && slot.isCrown && slot.secondCraftId !== null && slot.secondCraftId !== undefined) {
          const craft = this.craftById(slot.secondCraftId);
          fixedCrafts.push({ position: pos, craftId: slot.secondCraftId, type: craft && craft.craftType === "bond" ? "bond" : "other", slot: 1 });
        }
      });
      const manualExcludedCraftIds = (Array.isArray(this.excludedCrafts) ? this.excludedCrafts : []).map(Number);
      const cnUnavailableCraftIds = (this.serverRegion === "cn" ? (this.cnUnavailableCraftIds || []) : []).map(Number);
      const genericNotParticipatingIds = this.genericBondCrafts
        .filter((c) => !this.isCraftParticipating(c))
        .map((c) => Number(c.id));
      const nonParticipatingIds = (Array.isArray(this.nonParticipatingCraftIds) ? this.nonParticipatingCraftIds : []).map(Number);
      // 玩家自由礼装位：手动排除 + 服务器未实装 + 右键设为“不参与自动”的礼装，全部排除。
      // 助战是“借别人”的：手动排除不生效；但服务器未实装、以及用户右键关闭自动参与的礼装仍不进入。
      const supportExcludedCraftIds = [...cnUnavailableCraftIds, ...genericNotParticipatingIds, ...nonParticipatingIds];
      return {
        box,
        mode: this.mode,
        serverRegion: this.serverRegion,
        classGroup: this.mode === "crown" && this.crownClass && this.crownClass !== "all" ? this.crownClass : null,
        crownPositions: this.mode === "crown" ? crownPositions : [],
        baseBond: Number(this.baseBond || 0),
        sortMode: this.sortMode === "points" && Number(this.baseBond || 0) > 0 ? "points" : "multiplier",
        fixedServants,
        fixedCrafts,
        support,
        costLimit: Number(this.costLimit),
        strategy: this.strategy,
        targetServantId: this.strategy === "target_max" ? this.targetServantId : null,
        excludedServantIds: Array.from(new Set([...this.excludedServants, ...this.simpleExcludedServants].map(Number))),
        excludedCraftIds: Array.from(new Set([...manualExcludedCraftIds, ...cnUnavailableCraftIds, ...genericNotParticipatingIds, ...nonParticipatingIds])),
        supportExcludedCraftIds: Array.from(new Set(supportExcludedCraftIds)),
        activityBonus: 0,
        teaBonus: 1,
        topN: Number(this.resultSettings.resultTopN) || 200,
        craftPoolSize: 60,
        timeoutMs: this.superOn ? 3600000 : this.timeoutForQuality(this.qualityMode),
        neighborhood: this.superOn ? "deep" : (this.neighborhood || "standard"),
        searchOrder: this.superOn
          ? "craft"
          : (this.resultSettings.searchOrder === "servant" ? "servant" : "craft"),
        // 超级模式：只放大搜索范围、不设时间上限（停止由界面按钮触发）
        superMode: this.superOn ? Number(this.superLevel) : 0,
        // 活动从者优先（不足 50% 的档位也保送）；≥50% 由引擎始终保送，与此无关
        eventPriority: !!this.resultSettings.eventPriority,
      };
    },
    buildPresetPayload(preset) {
      const box = this.ownedServants.map((s) => {
        const b = this.box[s.id];
        const f = this.bondFlagsFor(b);          // 按牵绊等级推导（规则见 bondFlagsFor）
        return {
          id: s.id,
          stage: b.stage,
          maxBond: f.maxBond,
          bondSwitch1: f.switch1,
          bondSwitch2: f.switch2,
          personalBonus: Number(b.personalBonus || 0) / 100,
          auraBonus: Number(b.auraBonus || 0) / 100,
          // 玛修 Cost 覆盖（0/16）：没设置就不传，引擎按资料库里的 Cost 算
          costOverride: b.costOverride === null || b.costOverride === undefined ? null : Number(b.costOverride),
        };
      });
      const mode = preset.mode || this.mode;
      const crownClass = preset.crownClass || this.crownClass;
      const crownPositions = mode === "crown" ? (preset.crownPositions || []) : [];
      const support = {
        position: preset.supportPosition || "front_right",
        servantId: preset.supportId || null,
        craftId: preset.supportCraftId !== undefined && preset.supportCraftId !== null ? preset.supportCraftId : null,
        secondCraftId: mode === "crown" && preset.supportSecondCraftId !== undefined && preset.supportSecondCraftId !== null ? preset.supportSecondCraftId : null,
      };
      const manualExcludedCraftIds = (Array.isArray(this.excludedCrafts) ? this.excludedCrafts : []).map(Number);
      const cnUnavailableCraftIds = (this.serverRegion === "cn" ? (this.cnUnavailableCraftIds || []) : []).map(Number);
      const genericNotParticipatingIds = this.genericBondCrafts
        .filter((c) => !this.isCraftParticipating(c))
        .map((c) => Number(c.id));
      const nonParticipatingIds = (Array.isArray(this.nonParticipatingCraftIds) ? this.nonParticipatingCraftIds : []).map(Number);
      const supportExcludedCraftIds = [...cnUnavailableCraftIds, ...genericNotParticipatingIds, ...nonParticipatingIds];
      return {
        box,
        mode,
        serverRegion: this.serverRegion,
        classGroup: mode === "crown" && crownClass && crownClass !== "all" ? crownClass : null,
        crownPositions,
        baseBond: Number(preset.baseBond !== undefined ? preset.baseBond : this.baseBond || 0),
        sortMode: preset.sortMode === "points" ? "points" : "multiplier",
        fixedServants: preset.fixedServants || [],
        fixedCrafts: preset.fixedCrafts || [],
        support,
        costLimit: Number(preset.costLimit || this.costLimit),
        strategy: preset.strategy || this.strategy,
        targetServantId: this.strategy === "target_max" ? this.targetServantId : null,
        excludedServantIds: Array.from(new Set([...this.excludedServants, ...this.simpleExcludedServants].map(Number))),
        excludedCraftIds: Array.from(new Set([...manualExcludedCraftIds, ...cnUnavailableCraftIds, ...genericNotParticipatingIds, ...nonParticipatingIds])),
        supportExcludedCraftIds: Array.from(new Set(supportExcludedCraftIds)),
        activityBonus: 0,
        teaBonus: 1,
        topN: Number(this.resultSettings.resultTopN) || 200,
        craftPoolSize: 60,
        timeoutMs: this.timeoutForQuality(this.qualityMode),
        neighborhood: this.neighborhood || "standard",
        searchOrder: this.resultSettings.searchOrder === "servant" ? "servant" : "craft",
        eventPriority: !!this.resultSettings.eventPriority,
      };
    },
    isFullPreset(preset) {
      return !!preset && Array.isArray(preset.fixedServants) && preset.fixedServants.length >= 5 && !!preset.supportId;
    },
    seedablePresets() {
      return (this.presets || []).filter((p) => {
        if (!this.isFullPreset(p)) return false;
        if ((p.mode || "normal") !== this.mode) return false;
        if (this.mode === "crown" && (p.crownClass || "all") !== this.crownClass) return false;
        return true;
      });
    },
    resultSortValue(r) {
      // 排序口径跟搜索口径一致：默认按倍率；只有选了"按点数"且填了基础牵绊时才按点数
      if (this.sortMode === "points" && Number(r.baseBond || 0) > 0) {
        return Number(r.totalBondPoints || 0);
      }
      return Number(r.totalMultiplier || 0);
    },
    /** 是否展示"预计牵绊点数"：没填基础牵绊时那个数只是固定加成部分，容易误导 */
    showsBondPoints(r) {
      return !!r && Number(r.baseBond || 0) > 0 && Number(r.totalBondPoints || 0) !== 0;
    },
    resultTeamKey(r) {
      return JSON.stringify((r.team || []).map((m) => [m.position, m.servantId, m.craftId, m.secondCraftId]));
    },
    mergeRankResults(results) {
      const seen = new Set();
      const merged = [];
      for (const r of results || []) {
        const key = this.resultTeamKey(r);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      merged.sort((a, b) => this.resultSortValue(b) - this.resultSortValue(a));
      merged.forEach((r, i) => { r.rank = i + 1; });
      return merged;
    },
    async cancelCalculation() {
      if (!this.calculating) return;
      // 超级模式：点"停止"是**协作式**的 —— 引擎会把已经算出来的结果收尾后返回，
      // 所以这里只发停止请求，然后等正常的 promise 带着 status="partial" 回来。
      if (this.superOn) {
        this.superStopping = true;
        this.progress = "正在收尾（已算出的结果会保留）...";
        try {
          await window.fgo.cancelEngine();
        } catch (_) {
          // 引擎可能已经自行结束，忽略取消失败
        }
        return;
      }
      this.progress = "正在终止计算...";
      try {
        await window.fgo.cancelEngine();
      } catch (_) {
        // 引擎可能已经自行结束，忽略取消失败
      }
      this.calculating = false;
      this.progress = "";
      this.error = "计算已终止";
    },
    /** 超级模式开关（右上角）：开启后档位/完整度/邻域由它接管 */
    toggleSuperMode(on) {
      if (this.calculating) return;
      this.superLevel = on ? (Number(this.superLevel) > 1 ? Number(this.superLevel) : 2.5) : 0;
      this.superProgress = null;
      this.superPartial = false;
      // 红主题挂在 body 上（页面背景在 .board-app 之外，只挂组件上换不到底色）
      if (typeof document !== "undefined") {
        document.body.classList.toggle("super-mode", this.superOn);
      }
    },
    async calculate() {
      this.error = "";
      this.results = [];
      this.superPartial = false;
      this.superStopping = false;
      this.superProgress = null;
      this.verificationTokens = [];
      this.verificationTokensFull = [];
      this.verificationCopied = false;
      this.compareSelectedRanks = [];
      this.compareVisible = false;
      this.expandedResult = null;
      this.progress = "";
      if (!this.ownedServants.length) {
        this.error = "请先在 Box 管理中勾选至少一位从者";
        return;
      }
      const supportSlots = this.slots.filter((s) => s.isSupport).length;
      if (supportSlots > 1) {
        this.error = "助战位只能设置一个";
        return;
      }
      this.calculating = true;
      try {
        const payload = this.buildPayload();
        const result = await window.fgo.calculate(plainClone(payload));
        if (result.verificationToken) this.verificationTokens.push(result.verificationToken);
        if (result.verificationTokenFull) this.verificationTokensFull.push(result.verificationTokenFull);
        const allResults = [...(result.top20 || [])];
        // 超级模式下用户点了"停止"：引擎返回的是"已算出来并排好序"的部分结果
        this.superPartial = result.status === "partial";
        if (this.superPartial && !allResults.length) {
          this.error = "已停止：这次还没来得及算出任何队伍，下次可以多等一会儿再点停止";
        }
        // 把你保存过的完整预设作为“种子队伍”一并计算并合并进结果，
        // 避免完整预设因为搜索抽样/时间不足而完全不出现在结果里。
        // ⚠️ 超级模式跳过这一步：它自己的搜索范围已经足够，再逐条跑一遍要多花好几倍时间。
        for (const preset of (this.superOn ? [] : this.seedablePresets())) {
          try {
            const seedResult = await window.fgo.calculate(plainClone(this.buildPresetPayload(preset)));
            if (seedResult && seedResult.verificationToken) this.verificationTokens.push(seedResult.verificationToken);
            if (seedResult && seedResult.verificationTokenFull) this.verificationTokensFull.push(seedResult.verificationTokenFull);
            allResults.push(...((seedResult && seedResult.top20) || []).slice(0, 3));
          } catch (_) {
            // 单个预设不兼容/超时不影响主结果
          }
        }
        this.results = this.mergeRankResults(allResults);
        this.totalCandidates = result.totalCandidates || this.results.length;
        this.lastSearchStats = {
          elapsed: result._elapsed,
          processed: result._processed,
          totalCandidates: result.totalCandidates,
          // 搜索范围（引擎新增字段；旧引擎为 undefined → 界面自动不显示那一行）
          poolSize: result.poolSize,
          poolCombos: result.poolCombos,
          qualityMode: this.qualityMode,
          timeoutMs: payload.timeoutMs,
          // 引擎的时间上限兜底：true = 还没跑完就被砍了（换更高档位可能更好）
          truncated: !!result.truncated,
          // 超级模式：本次是不是"用户中途停止"得到的部分结果
          partial: result.status === "partial",
          superLevel: this.superOn ? Number(this.superLevel) : 0,
        };
        // 「保存计算结果」用的快照：存界面**看到的这一份**（含被合并进来的种子预设行），
        // 这样打开存档能原样重现，不需要重算。
        this.lastResultSnapshot = {
          results: plainClone(this.results),
          stats: plainClone(this.lastSearchStats),
          payload: plainClone(payload),
          dataRevision: (this.info && this.info.dataUpdatedAt) || null,
          clientVersion: (this.info && this.info.version) || null,
        };
        this.loadedResultInfo = null;
        this.currentPage = 1;
        if (this.resultSettings.autoExpandFirst && this.results.length) {
          this.expandedResult = this.results[0];
        }
        setTimeout(() => {
          document.querySelector(".results-section")?.scrollIntoView({ behavior: "smooth" });
        }, 50);
      } catch (e) {
        this.error = e.message || String(e);
        this.verificationTokens = [];
        this.verificationTokensFull = [];
        this.verificationCopied = false;
      } finally {
        this.calculating = false;
      }
    },
    /** 更新数据的步骤表：**顺序 = 引擎真实执行顺序**（两个下载都在写入之前）。
     *  doneDetail 是"这一格做完之后该显示什么" —— 只改 status 不改 detail 会让界面出现
     *  「✅ 下载从者数据 / 开始下载...」这种自相矛盾的行（2026-10-25 用户截图指出）。 */
    initUpdateItems() {
      return [
        { key: "check", label: "检查更新", status: "pending", detail: "", percent: null, doneDetail: "已连接数据源" },
        { key: "servant_download", label: "下载从者数据", status: "pending", detail: "", percent: null, doneDetail: "下载完成" },
        { key: "equip_download", label: "下载礼装数据", status: "pending", detail: "", percent: null, doneDetail: "下载完成" },
        { key: "servant_write", label: "写入从者/特性", status: "pending", detail: "", percent: null, doneDetail: "写入完成" },
        { key: "equip_write", label: "写入礼装数据", status: "pending", detail: "", percent: null, doneDetail: "写入完成" },
        { key: "costume", label: "更新灵衣名称", status: "pending", detail: "", percent: null, doneDetail: "全部完成" },
        { key: "event", label: "活动牵绊加成", status: "pending", detail: "", percent: null, doneDetail: "已更新" },
        { key: "done", label: "完成", status: "pending", detail: "", percent: null, doneDetail: "更新完成" },
      ];
    },
    setUpdateItem(key, status, detail, percent) {
      const item = this.updateItems.find((i) => i.key === key);
      if (!item) return;
      item.status = status;
      if (detail !== undefined) item.detail = detail;
      if (percent !== undefined) item.percent = percent;
    },
    /** 标记某一步完成：**同时**把小字换成完成态（不换就会卡在"正在…"） */
    markItemDone(key, detail) {
      const item = this.updateItems.find((i) => i.key === key);
      if (!item) return;
      item.status = "done";
      item.detail = detail !== undefined ? detail : (item.doneDetail || "完成");
      if (item.percent !== null) item.percent = 100;
    },
    /** 左上角状态文字：跑完别显示"空闲"（上面全是 ✅ 完成，写着空闲像没跑） */
    updateStateText() {
      if (this.updateRunning) return "处理中...";
      if (this.updateError) return "上次出错";
      if (this.updateResult) return "上次完成";
      return "空闲";
    },
    handleUpdateProgress(rawMsg) {
      if (!this.updateRunning || !this.updateItems.length) return;
      const msg = String(rawMsg || "")
        .replace(/^\[progress\]\s*/i, "")
        .replace(/^\[data_fetcher\]\s*/i, "");
      const activeKey = () => {
        const it = this.updateItems.find((i) => i.status === "running");
        return it ? it.key : null;
      };
      const markActiveDone = () => {
        const key = activeKey();
        if (key) this.markItemDone(key);
      };

      if (msg.includes("正在检查数据更新")) {
        this.setUpdateItem("check", "running", "正在连接数据源...");
        return;
      }
      if (msg.includes("正在下载从者数据")) {
        markActiveDone();
        this.setUpdateItem("servant_download", "running", "开始下载...", null);
        return;
      }
      if (msg.includes("正在下载礼装数据")) {
        markActiveDone();
        this.setUpdateItem("equip_download", "running", "开始下载...", null);
        return;
      }
      if (msg.includes("正在写入从者与特性数据")) {
        markActiveDone();
        this.setUpdateItem("servant_write", "running", "正在写入本地数据库...");
        return;
      }
      if (msg.includes("正在写入礼装数据")) {
        markActiveDone();
        this.setUpdateItem("equip_write", "running", "正在写入本地数据库...");
        return;
      }
      if (msg.includes("正在更新灵衣名称")) {
        markActiveDone();
        const m = msg.match(/(\d+)\/(\d+)/);
        const pct = m ? Math.round((Number(m[1]) / Number(m[2])) * 100) : null;
        this.setUpdateItem("costume", "running", msg, pct);
        return;
      }
      if (msg.includes("正在下载活动数据")) {
        markActiveDone();
        this.setUpdateItem("event", "running", "正在下载活动数据...", null);
        return;
      }
      if (msg.includes("正在读取从者活动被动技能")) {
        this.setUpdateItem("event", "running", "正在读取从者活动被动技能...");
        return;
      }
      if (msg.includes("正在解析活动牵绊加成")) {
        this.setUpdateItem("event", "running", "正在解析活动加成...");
        return;
      }
      if (msg.includes("活动牵绊加成解析完成")) {
        this.markItemDone("event", msg.replace(/^.*解析完成：/, "已解析："));
        return;
      }
      if (msg.includes("数据更新完成") || msg.includes("数据已是最新版本")) {
        markActiveDone();
        this.markItemDone("done", msg.includes("最新") ? "无需更新" : "更新完成");
        return;
      }

      // 下载明细行：`nice_servant: 45% (30.0/66.0 MB, 0.19 MB/s, 约剩 172s)` / `nice_servant: done -> <路径>`
      const dl = msg.match(/^(nice_servant|nice_equip|nice_event|basic_event_cn):\s*(.+)$/);
      if (dl) {
        const key =
          dl[1] === "nice_servant" ? "servant_download" : dl[1] === "nice_equip" ? "equip_download" : "event";
        const rest = dl[2].trim();
        if (rest.startsWith("done")) {
          this.markItemDone(key, "下载完成");
          return;
        }
        const pm = rest.match(/^(\d+)%\s*(?:\(([^)]*)\))?/);
        if (pm) {
          const pct = Number(pm[1]);
          const extra = pm[2] ? "（" + pm[2] + "）" : "";
          this.setUpdateItem(key, "running", "下载中 " + pct + "%" + extra, pct);
          return;
        }
        this.setUpdateItem(key, "running", rest);
      }
    },
    /**
     * 安卓端不提供「更新数据」：数据与头像一起随 APK 发布（见 PLATFORM-ROADMAP 的决策），
     * 装新版就是更新数据。界面据此隐藏入口，方法里也各留一道保险。
     */
    isAndroidPlatform() {
      return !!(this.info && this.info.platform === "android");
    },
    openUpdateModal() {
      if (this.isAndroidPlatform()) return;
      this.updateTitle = "更新数据";
      this.updateModalVisible = true;
      if (!this.updateRunning && !this.updateItems.length) {
        this.updateItems = this.initUpdateItems();
      }
    },
    /** 点左上角「FGO牵绊推荐器」进入：版本与更新信息（含"检查软件更新"） */
    openVersionModal() {
      this.updateTitle = "版本与更新信息";
      this.updateModalVisible = true;
      this.appUpdateError = "";
    },
    /** 检查软件更新：只查最新版本号（多源依次试），不下载不安装 */
    async checkAppUpdate() {
      this.appUpdateChecking = true;
      this.appUpdateError = "";
      try {
        this.appUpdate = await window.fgo.checkAppUpdate();
      } catch (e) {
        this.appUpdateError = e.message || String(e);
      } finally {
        this.appUpdateChecking = false;
      }
    },
    /** 用系统浏览器打开链接（白名单在宿主侧校验） */
    async openExternalLink(url) {
      try {
        await window.fgo.openExternal(url);
      } catch (e) {
        this.appUpdateError = e.message || String(e);
      }
    },
    closeUpdateModal() {
      if (!this.updateRunning) this.updateModalVisible = false;
    },
    /**
     * 只检查远程是否有新数据（HEAD 比对，秒回、不下载）。
     * 与「更新数据」拆成两个按钮：检查用来看值不值得更新，更新是无条件重建。
     */
    async runCheck(progressItemKey = "check") {
      if (this.isAndroidPlatform()) return; // 安卓：数据随 APK 发布
      this.updateTitle = "更新数据";
      this.updateModalVisible = true;
      this.updateRunning = true;
      this.updateResult = null;
      this.updateError = "";
      if (!this.updateItems.length) this.updateItems = this.initUpdateItems();
      this.setUpdateItem(progressItemKey, "running", "正在检查远程数据...");
      try {
        const r = await window.fgo.checkDataUpdate();
        this.updateRunning = false;
        this.updateResult = r;
        if (r && r.status === "update_available") {
          const detail = (r.reasons || []).join("、") || "远程有新数据";
          this.setUpdateItem(progressItemKey, "done", detail + "，可以更新");
        } else {
          this.setUpdateItem(progressItemKey, "done", "本地已是最新版本");
        }
      } catch (e) {
        this.updateRunning = false;
        this.updateError = e.message || String(e);
        this.setUpdateItem(progressItemKey, "error");
      }
    },
    /**
     * 更新数据：**无条件全量重建**（要不要更新请先用「检查刷新」看一眼）。
     * 安卓端不提供「更新数据」：数据与头像一起随 APK 发布（见 PLATFORM-ROADMAP 的决策），
     * 界面据此隐藏入口，方法里也各留一道保险。
     */
    async runUpdate() {
      if (this.isAndroidPlatform()) return; // 安卓：数据随 APK 发布，不提供联网更新
      this.updateModalVisible = true;
      this.updateTitle = "更新数据";
      this.updateRunning = true;
      this.updateResult = null;
      this.updateError = "";
      this.updateItems = this.initUpdateItems();
      this.setUpdateItem("check", "running", "正在下载并重建...");
      try {
        const r = await window.fgo.updateData();
        this.updateRunning = false;
        this.updateResult = r;
        if (r && r.status === "no_change") {
          this.setUpdateItem("check", "done", "本地已是最新版本");
          this.setUpdateItem("done", "done", "无需更新");
        } else {
          const active = this.updateItems.find((i) => i.status === "running");
          if (active) this.markItemDone(active.key);
          this.markItemDone("done", "更新完成");
          try {
            await this.reloadAllData();
            this.updateResult = Object.assign({}, r, { uiReloaded: true });
            // 更新时主进程会顺手补齐缺失头像，这里让之前显示不出来的头像重新加载
            this.retryBrokenAvatars();
          } catch (reloadErr) {
            this.updateError = (this.updateError ? this.updateError + "\n" : "") + ("刷新界面数据失败: " + (reloadErr.message || String(reloadErr)));
          }
        }
      } catch (e) {
        this.updateRunning = false;
        this.updateError = e.message || String(e);
        const active = this.updateItems.find((i) => i.status === "running");
        if (active) this.setUpdateItem(active.key, "error");
      }
    },
    /**
     * 重置数据库：清空静态数据（从者/礼装/特性/灵衣）后强制重建一次。
     * 个人数据（账号/Box/排除/预设/自定义礼装）保留；失败会自动回滚。
     */
    async runDatabaseReset() {
      if (this.calculating || this.updateRunning) return;
      this.updateModalVisible = true;
      this.updateTitle = "重置数据库";
      this.updateRunning = true;
      this.updateResult = null;
      this.updateError = "";
      this.updateItems = [
        { key: "reset_clear", label: "清空本地静态数据", status: "running", detail: "正在清空从者/礼装/特性/灵衣表...", percent: null },
        ...this.initUpdateItems(),
      ];
      try {
        this.setUpdateItem("reset_clear", "done", "已清空（个人数据保留）");
        const r = await window.fgo.resetStaticData();
        const active = this.updateItems.find((i) => i.status === "running");
        if (active) this.markItemDone(active.key);
        this.markItemDone("done", "重建完成");
        this.updateResult = r;
        // 静态数据变了，旧结果作废
        this.results = [];
        this.compareSelectedRanks = [];
        this.simpleExcludedServants = [];
        this.expandedResult = null;
        try {
          await this.reloadAllData();
        } catch (reloadErr) {
          this.updateError = "刷新界面数据失败: " + (reloadErr.message || String(reloadErr));
        }
      } catch (e) {
        this.updateError = e.message || String(e);
        const active = this.updateItems.find((i) => i.status === "running");
        if (active) this.setUpdateItem(active.key, "error");
      } finally {
        this.updateRunning = false;
      }
    },
    async exportJson(result) {
      // 导出"这一行当前显示"的阵容（若在同分下拉里选过某一支，就导出那一支）
      // ⇒ Cost 也得跟着是这一支的，否则导出 JSON 里的 costUsed 与 team 自相矛盾
      const payload = { ...result, team: this.displayedResultTeam(result), costUsed: this.resultCostUsed(result) };
      const text = JSON.stringify(payload, null, 2);
      const name = `FGO方案#${result.rank}.json`;
      // ⚠️ 安卓 WebView 不处理 <a download>（原来点「导出JSON」没反应就是这个原因），
      // 所以两条平台都走 saveTextFile：桌面弹保存框，安卓写进「文档」目录。
      if (window.fgo && typeof window.fgo.saveTextFile === "function") {
        try {
          const r = await window.fgo.saveTextFile({ name, text });
          if (r && r.ok && r.copied) {
            alert("文件没能写进手机存储，已把内容复制到剪贴板：粘贴到任意文本里保存即可");
            return;
          }
          if (r && r.ok) {
            alert(`已导出：${r.path}`);
            return;
          }
          if (r && r.canceled) return;
          alert("导出失败：" + ((r && r.error) || "未知原因"));
          return;
        } catch (e) {
          alert("导出失败：" + (e && e.message ? e.message : String(e)));
          return;
        }
      }
      // 老宿主（没有 saveTextFile）退回浏览器下载
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    async copyVerificationCode() {
      let tokens = (this.activeVerificationTokens || []).filter(Boolean);
      // 兼容旧引擎：如果当前模式没有验证串，就退回另一种模式。
      if (!tokens.length) {
        const fallback = this.verificationMode === "full" ? this.verificationTokens : this.verificationTokensFull;
        if ((fallback || []).length) {
          this.verificationMode = this.verificationMode === "full" ? "repro" : "full";
          tokens = fallback.filter(Boolean);
        }
      }
      if (!tokens.length) return;
      try {
        // 如果一次计算还合并了保存的“完整预设种子队伍”，会包含多段；
        // 每段一行，便于逐行复制与核对。
        await window.fgo.copyText(tokens.join("\n"));
        this.verificationCopied = true;
        setTimeout(() => { this.verificationCopied = false; }, 2500);
      } catch (e) {
        alert("复制失败：" + (e && e.message ? e.message : String(e)));
      }
    },
    openVerificationModeMenu(e) {
      if (e) e.preventDefault();
      this.contextMenu = {
        visible: true,
        x: e ? e.clientX : 0,
        y: e ? e.clientY : 0,
        slotIndex: null,
        target: "verification-mode",
        result: null,
        member: null,
      };
    },
    setVerificationMode(mode) {
      this.verificationMode = mode === "full" ? "full" : "repro";
      this.verificationCopied = false;
      this.closeContextMenu();
    },
    openFeedbackModeMenu(e) {
      if (e) e.preventDefault();
      this.contextMenu = {
        visible: true,
        x: e ? e.clientX : 0,
        y: e ? e.clientY : 0,
        slotIndex: null,
        target: "feedback-mode",
        result: null,
        member: null,
      };
    },
    setFeedbackMode(mode) {
      this.resultSettings.feedbackMode = mode === "full" ? "full" : "brief";
      this.persistResultSettings();
      this.closeContextMenu();
    },
    participatingBox() {
      const excluded = new Set([
        ...(this.excludedServants || []),
        ...(this.simpleExcludedServants || []),
      ].map(Number));
      return this.ownedServants
        .filter((s) => !excluded.has(Number(s.id)))
        .map((s) => {
          const b = this.box[s.id] || {};
          return {
            id: s.id,
            name: s.name,
            class: s.class,
            cost: s.cost,
            rarity: s.rarity,
            stage: b.stage || "fourth",
            maxBond: !!b.maxBond,
            switch1: !!b.switch1,
            switch2: !!b.switch2,
            personalBonus: Number(b.personalBonus || 0),
            auraBonus: Number(b.auraBonus || 0),
          };
        });
    },
    feedbackCraftPool() {
      const excluded = new Set((this.excludedCrafts || []).map(Number));
      if (this.serverRegion === "cn") {
        (this.cnUnavailableCraftIds || []).forEach((id) => excluded.add(Number(id)));
      }
      (this.nonParticipatingCraftIds || []).forEach((id) => excluded.add(Number(id)));
      this.genericBondCrafts.forEach((c) => {
        if (!this.isCraftParticipating(c)) excluded.add(Number(c.id));
      });
      return this.meaningfulBondCrafts
        .filter((c) => !excluded.has(Number(c.id)))
        .filter((c) => c && c.craftType === "bond")
        .filter((c) => Number(c.supportBonus || 0) <= 0)
        .sort((a, b) => {
          const ua = a.bonusType === "universal" ? 0 : 1;
          const ub = b.bonusType === "universal" ? 0 : 1;
          return ua - ub || Number(b.bonusValue || 0) - Number(a.bonusValue || 0) || Number(a.id) - Number(b.id);
        })
        .map((c) => ({
          id: c.id,
          name: c.name,
          rarity: c.rarity,
          cost: c.cost,
          bonusType: c.bonusType,
          bonusValue: Number(c.bonusValue || 0),
          flatBonus: Number(c.flatBonus || 0),
          repeatable: !!c.repeatable,
          isCustom: !!c.isCustom,
          trigger: c.bonusType === "trait" ? this.traitGroupsText(c) : "",
        }));
    },
    /**
     * 把系统原生下拉框（<select>）换成**界面内浮层列表**。
     *
     * 为什么：Electron 有个一直没修的已知问题 —— 点原生 <select> 时那个弹窗**有时根本不出现**
     * （electron/electron#44186，Electron 30 起就有人反复报；绕法是"关硬件加速"或"进出全屏"）。
     * 用户实测：Box 管理里的「职阶 / 满绊筛选 / 活动」点了没反应，其他按钮正常，最小化再打开才出来。
     * 我们自己画浮层就绕开了这个 bug（不依赖系统弹窗）。
     *
     * 做法：**捕获阶段**拦掉 mousedown 并 preventDefault（系统弹窗就不会出来）→ 用原生 <option>
     * 自己渲染一个列表 → 选中后写回 select.value 并派发 change，Vue 的 v-model 照常工作。
     * 安卓端不启用（那边是系统原生选择器，行为本来就不同，不去动它）。
     */
    installSelectShim() {
      if (this.isAndroidPlatform()) return;
      if (this._selectShimInstalled) return;
      this._selectShimInstalled = true;

      const popup = document.createElement("div");
      popup.className = "select-shim";
      popup.style.display = "none";
      document.body.appendChild(popup);

      /** 当前浮层是给哪个 <select> 打开的（用来实现"再点一下同一个框就收起来"） */
      let currentSelect = null;

      const close = () => {
        popup.style.display = "none";
        popup.innerHTML = "";
        currentSelect = null;
      };

      const open = (select) => {
        currentSelect = select;
        popup.innerHTML = "";
        let activeItem = null;
        for (const opt of Array.from(select.options)) {
          const item = document.createElement("div");
          item.className = "select-shim-item";
          if (opt.disabled) item.classList.add("disabled");
          if (opt.value === select.value) {
            item.classList.add("active");
            activeItem = item;
          }
          item.textContent = opt.textContent;
          item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (opt.disabled) return;
            select.value = opt.value;
            // 走原生 change 事件：v-model / @change 都照旧生效
            select.dispatchEvent(new Event("change", { bubbles: true }));
            close();
          });
          popup.appendChild(item);
        }
        const rect = select.getBoundingClientRect();
        popup.style.display = "block";
        popup.style.minWidth = Math.max(120, Math.round(rect.width)) + "px";
        popup.style.left = Math.max(4, Math.round(rect.left)) + "px";
        popup.style.top = Math.round(rect.bottom + 2) + "px";
        // 下面放不下就往上弹
        const height = popup.offsetHeight;
        if (rect.bottom + 2 + height > window.innerHeight - 4) {
          popup.style.top = Math.max(4, Math.round(rect.top - 2 - height)) + "px";
        }
        if (activeItem && activeItem.scrollIntoView) activeItem.scrollIntoView({ block: "nearest" });
      };

      document.addEventListener(
        "mousedown",
        (ev) => {
          const target = ev.target;
          if (popup.contains(target)) return;
          const select = target && target.closest ? target.closest("select") : null;
          if (!select) {
            close();
            return;
          }
          if (select.disabled) return;
          ev.preventDefault(); // 关键：不让系统弹窗出来
          ev.stopPropagation();
          // 再点同一个下拉框 = 收起来（用户要求：不必非得点别处才关）
          if (currentSelect === select && popup.style.display !== "none") {
            close();
            return;
          }
          open(select);
        },
        true
      );

      // 点别处 / 窗口失焦 / Esc 都收起来
      document.addEventListener(
        "click",
        (ev) => {
          const target = ev.target;
          if (popup.contains(target)) {
            ev.stopPropagation();
            return;
          }
          if (target && target.closest && target.closest("select")) return;
          close();
        },
        true
      );
      window.addEventListener("blur", close);
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") close();
      });
    },
  },
  template: `
  <div class="board-app" :class="{ 'super-mode': superOn }" @click="closeContextMenu">
    <!-- 顶部工具栏 -->
    <div class="topbar">
      <div class="topbar-brand">
        <h1 class="brand-link" title="版本与更新信息（检查软件更新）" @click.stop="openVersionModal">FGO牵绊推荐器</h1>
        <div class="account-switch" @click.stop>
          <span class="server-label">账号</span>
          <select
            class="account-select"
            :value="activeAccountId"
            :disabled="accountBusy || calculating"
            @change="switchAccount($event.target.value)"
          >
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}（{{ a.servantCount }}）</option>
          </select>
          <button class="secondary" @click="openAccountManager">＋ 新建 / 管理</button>
        </div>
        <!-- PC 端：设置拆成左上下拉（安卓没有系统菜单，见右侧「设置」按钮） -->
        <div v-if="!isAndroidPlatform()" class="settings-menu" @click.stop>
          <button class="secondary" @click.stop="settingsMenuOpen = !settingsMenuOpen">设置 ▾</button>
          <div v-if="settingsMenuOpen" class="settings-menu-list">
            <button @click="openSettings('calc')">计算设置</button>
            <button @click="openSettings('display')">结果显示设置</button>
            <button v-if="diagLogAvailable()" @click="openSettings('diag')">诊断日志</button>
          </div>
        </div>
      </div>
      <div>
        <button class="secondary" @click.stop="boxModalVisible = true">Box管理</button>
        <button class="secondary" @click.stop="exclusionModalVisible = true">排除管理</button>
        <button class="secondary" @click.stop="openCustomManager">自定义礼装</button>
        <button v-if="!isAndroidPlatform()" class="secondary" @click.stop="openUpdateModal">更新数据</button>
        <!-- 设置必须能从界面进：安卓没有系统菜单，只能靠这个按钮（PC 端已挪到左上角「设置 ▾」） -->
        <button v-if="isAndroidPlatform()" class="secondary" @click.stop="openSettings()">设置</button>
        <!-- 使用说明：PC 走菜单「帮助 → 使用说明」(F1)，安卓没有菜单所以给按钮 -->
        <button v-if="isAndroidPlatform()" class="secondary" @click.stop="openManual">使用说明</button>
      </div>
    </div>

    <!-- 模式切换 -->
    <div class="mode-switch">
      <button :class="{ active: mode === 'normal' }" @click="switchMode('normal')">普通战斗</button>
      <button :class="{ active: mode === 'crown' }" @click="switchMode('crown')">戴冠战模式</button>
    </div>

    <!-- 服务器选择 -->
    <div class="server-switch">
      <span class="server-label">服务器</span>
      <button :class="{ active: serverRegion === 'jp' }" @click="setServerRegion('jp')">日服</button>
      <button :class="{ active: serverRegion === 'cn' }" @click="setServerRegion('cn')">简中服</button>
    </div>

    <!-- 戴冠战职阶筛选（一级界面） -->
    <div v-if="mode === 'crown'" class="crown-filter panel">
      <div class="team-config-title">戴冠战职阶筛选</div>
      <div class="crown-filter-buttons">
        <button
          v-for="opt in crownClassFilters()"
          :key="opt.value"
          :class="{ active: crownClass === opt.value }"
          @click="crownClass = opt.value; results = []; currentPage = 1"
        >{{ opt.label }}</button>
      </div>
      <div class="text-muted" style="margin-top:6px">选定职阶后，只有该职阶从者参与计算；冠位从者位通过右键菜单设置。</div>
    </div>

    <div v-if="error" class="panel error">{{ error }}</div>
    <div v-if="loading" class="empty">加载中...</div>
    <template v-else>
      <!-- 6 槽位主区域 -->
      <div class="board-area">
        <div v-for="(slot, i) in slots" :key="i" class="slot-col" :class="{ 'slot-support': slot.isSupport, 'slot-crown': mode === 'crown' && slot.isCrown }">
          <div
            class="cell cell-servant"
            :class="{ empty: !slot.servantId, support: slot.isSupport, 'drag-over': dragOverSlot === i && dragState.type === 'servant' }"
            :draggable="!!slot.servantId"
            @click="openOverlay(i, 'servant')"
            @contextmenu="openContextMenu($event, i, 'servant')"
            @dragstart="onServantDragStart($event, i)"
            @dragend="clearDragState"
            @dragover.prevent="onSlotDragOver($event, i)"
            @drop.prevent="onSlotDrop($event, i)"
          >
            <template v-if="slot.servantId">
              <img
                v-if="!avatarMissingSet.has(String(slot.servantId))"
                :src="avatarPath(slot.servantId)"
                class="cell-avatar"
                alt=""
                @error="markAvatarBroken(slot.servantId)"
                @mouseenter="showHover($event, slotServant(slot))"
                @mousemove="moveHover($event)"
                @mouseleave="hideHover"
              />
              <div v-else class="cell-avatar fallback" @mouseenter="showHover($event, slotServant(slot))" @mousemove="moveHover($event)" @mouseleave="hideHover">{{ slotServant(slot).name.charAt(0) }}</div>
              <div v-if="slot.isSupport" class="support-tag">助战</div>
              <div v-else class="fixed-mark">🔒</div>
            </template>
            <template v-else>
              <span class="placeholder">{{ slot.isSupport ? '助战从者' : '从者' }}</span>
            </template>
            <div v-if="mode === 'crown' && slot.isCrown" class="crown-star" title="冠位从者位（允许两个加成礼装）">✴</div>
          </div>

          <div class="craft-stack" :class="{ 'crown-mode': mode === 'crown', 'has-second': mode === 'crown' && slot.isCrown }">
            <div
              v-for="cs in slotCraftItems(slot)"
              :key="cs.index"
              class="cell cell-craft"
              :class="{ empty: cs.craftId === null || cs.craftId === undefined, second: cs.index === 1, 'no-img': cs.craftId !== null && cs.craftId !== undefined && !hasCraftImage(cs.craft), 'drag-over': dragOverSlot === i && dragOverCraft === cs.index }"
              :draggable="cs.craftId !== null && cs.craftId !== undefined && Number(cs.craftId) !== 0"
              @click="openOverlay(i, 'craft', cs.index)"
              @contextmenu="openContextMenu($event, i, 'craft', cs.index)"
              @dragstart="onCraftDragStart($event, i, cs.index)"
              @dragend="clearDragState"
              @dragover.prevent="onCraftDragOver($event, i, cs.index)"
              @drop.prevent="onCraftDrop($event, i, cs.index)"
            >
              <template v-if="cs.craftId !== null && cs.craftId !== undefined">
                <img v-if="hasCraftImage(cs.craft)" :src="craftImagePath(cs.craft)" class="cell-craft-img" alt="" />
                <div class="cell-name small">{{ cs.craft.name }}</div>
                <div class="cell-meta">{{ cs.craft.rarity }}★ / {{ cs.index === 1 ? 'Cost 0' : 'Cost ' + cs.craft.cost }}</div>
                <div class="cell-effect">{{ craftEffect(cs.craft) }}</div>
              </template>
              <template v-else>
                <span class="placeholder">{{ slot.isSupport ? '助战礼装' : (cs.index === 1 ? '第二礼装位' : '礼装') }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 自由位过多提醒：这一行**高度固定预留**（出现/消失都不挤动下面的框），右对齐到第 6 宫格下方。
           条件 = 自由位 ≥4 且未开超级模式；说明走原生 title 悬停（与「本次搜索」那行的 ⓘ 同一做法）。 -->
      <div class="board-warn-row">
        <div v-if="freeCount >= 4 && !superOn" class="board-warn">
          ⚠️ 自由位偏多：耗时更久、结果更易波动，建议开超级模式
          <span class="board-warn-info" :title="'自由位越多，需要试着搭配的可能性就越多：耗时明显变长，低档位下也更容易漏掉个别队伍。想更稳妥可以开启「超级模式」——它不设时间上限、范围也更大。'">ⓘ</span>
        </div>
      </div>

      <!-- 底部信息/操作 -->
      <div class="bottom-bar panel">
        <div class="text-muted">
          Cost {{ costUsed }}/{{ costLimit }} | 固定 {{ fixedCount }} | 自由 {{ freeCount }} | 助战 {{ supportCount }}<span v-if="mode === 'crown'"> | 冠位 {{ crownCount }}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
          <button class="secondary" @click="resetTeam">清空队伍</button>
          <button class="secondary" @click="randomFillFree">随机填充自由位</button>
          <button class="secondary" @click="saveTeam">保存队伍</button>
          <button class="secondary" @click="presetModalVisible = true; presets = presets">加载预设</button>
          <button class="primary main-action" :disabled="calculating" @click="calculate">🚀 开始计算</button>
          <button class="secondary danger" :disabled="!calculating" @click="cancelCalculation">
            {{ superOn ? '⏹ 停止（保留已算结果）' : '⏹ 终止计算' }}
          </button>
        </div>
        <div v-if="calculating && superOn" class="super-progress">
          🚀 超级模式 ×{{ superLevel }}：已评
          {{ superProgress ? formatCount(superProgress.processed) : 0 }} 支 ｜ 已用
          {{ superProgress ? Math.round(superProgress.elapsed) : 0 }} 秒
          <template v-if="superStopping">｜ 正在收尾，已算出的结果会保留…</template>
        </div>
        <progress-bar :visible="calculating" :message="progress"></progress-bar>
      </div>

      <!-- 队伍配置（一级页面） -->
      <div class="team-config panel">
        <div class="team-config-head">
          <div class="team-config-title">队伍配置</div>
          <div class="super-toggle" :class="{ on: superOn }" @click.stop>
            <label
              class="super-switch"
              :title="'超级模式：不设时间上限，按最大范围搜索。开启后「计算档位 / 结果完整度 / 邻域」由它接管（固定走最大覆盖），其余设置照旧可用。'"
            >
              <input
                type="checkbox"
                :checked="superOn"
                :disabled="calculating"
                @change="toggleSuperMode($event.target.checked)"
              />
              <span>🚀 超级模式</span>
            </label>
            <select v-if="superOn" v-model.number="superLevel" :disabled="calculating" title="覆盖倍数：越大越全，也越慢">
              <option :value="2.5">×2.5</option>
              <option :value="5">×5</option>
              <!-- 手机上不提供 ×10：它对内存的放大是 5~8 倍（实测 RSS 4.9GB），而 WebView 的堆上限抬不了 -->
              <option v-if="!isAndroidPlatform()" :value="10">×10</option>
            </select>
            <span v-if="superOn" class="super-hint">不设时限</span>
          </div>
        </div>
        <div v-if="superOn" class="super-note team-config-note">
          🚀 超级模式已开启：下面的「邻域优化 / 计算质量」由它接管（固定按最大范围搜索、不设时间上限）。
          关掉右上角的超级模式即可恢复手动设置。
        </div>
        <div class="team-config-group">
          <div class="team-config-group-title">基础</div>
          <div class="team-config-grid">
            <div class="field">
              <label>Cost上限</label>
              <input type="number" min="50" max="200" v-model.number="costLimit" />
            </div>
            <div class="field">
              <label>策略</label>
              <select v-model="strategy">
                <option value="total_max">总牵绊最大化</option>
                <option value="target_max">指定从者最大化</option>
                <option value="balanced">均衡模式</option>
              </select>
            </div>
            <div v-if="strategy === 'target_max'" class="field target-field">
              <label>指定从者</label>
              <input v-model="targetServantKeyword" placeholder="搜索从者名称" />
              <div class="target-list">
                <button
                  v-for="s in targetServantCandidates"
                  :key="s.id"
                  :class="{ active: targetServantId === s.id }"
                  @click="targetServantId = s.id"
                >
                  {{ s.name }}
                  <span class="text-muted">{{ s.class }} / {{ s.rarity }}★ / {{ s.collectionNo }}</span>
                </button>
                <div v-if="!targetServantCandidates.length" class="empty">没有匹配从者</div>
              </div>
              <div v-if="targetServantId && servantMap[targetServantId]" class="text-muted" style="margin-top:6px">
                当前指定：{{ servantMap[targetServantId].name }}
              </div>
            </div>
          </div>
        </div>
        <div class="team-config-group">
          <div class="team-config-group-title">搜索强度</div>
          <div class="team-config-grid">
            <div class="field">
              <label title="关闭最快；标准默认；深入会额外试「同时换 3 人」，能找到更远的解但更慢。">邻域优化（换人再算）</label>
              <select v-model="neighborhood" :disabled="calculating || superOn">
                <option value="off">关闭（最快）</option>
                <option value="standard">标准（默认）</option>
                <option value="deep">深入（最多同时换 3 人，最慢）</option>
              </select>
              <div class="text-muted">算完后把靠前的队伍互相换人再算一遍。</div>
            </div>
            <div class="field">
              <label title="档位只决定搜索量和等待上限；实际耗时主要看「结果最多计算数量」。">计算质量 / 等待时间</label>
              <select v-model="qualityMode" :disabled="calculating || superOn">
                <option value="fast">快速（约 35 秒上限）</option>
                <option value="standard">标准（约 60 秒上限）</option>
                <option value="balanced">平衡（默认，约 90 秒上限）</option>
                <option value="high">高质量（约 135 秒上限）</option>
                <option value="extreme">极限精算（约 300 秒上限，同高质量）</option>
              </select>
              <div class="text-muted">算完就返回，不会等满。</div>
            </div>
            <div class="field">
              <label title="20~50 条几秒出结果；200 条约半分钟；500/1000 可能被时间上限截断。">结果最多计算数量</label>
              <select v-model.number="resultSettings.resultTopN" @change="persistResultSettings">
                <option :value="20">20 条（最快）</option>
                <option :value="50">50 条（快）</option>
                <option :value="100">100 条</option>
                <option :value="200">200 条（默认）</option>
                <option :value="500">500 条（慢）</option>
                <option :value="1000">1000 条（最慢）</option>
              </select>
              <div class="text-muted">条数越多越慢（最多差十几倍）。</div>
            </div>
            <div class="field">
              <label>活动从者优先</label>
              <label
                class="team-config-check"
                title="活动加成 +50% 及以上的从者始终优先纳入；勾上这里，+20% 这类不足 +50% 的档位也会一并优先纳入。活动从者多的 Box 建议勾上。"
              >
                <input
                  type="checkbox"
                  v-model="resultSettings.eventPriority"
                  :disabled="calculating"
                  @change="persistResultSettings"
                />
                <span>不足 +50% 的档位也优先纳入</span>
              </label>
            </div>
          </div>
        </div>
        <div class="team-config-group">
          <div class="team-config-group-title">牵绊与排序</div>
          <div class="team-config-grid">
            <div class="field">
              <label title="填 0 时结果只显示倍率；填实际基础值后显示预计牵绊数。">基础牵绊获取数值（默认0）</label>
              <input type="number" min="0" step="1" v-model.number="baseBond" placeholder="0" />
              <div class="text-muted">填 0 只看倍率；填了显示预计牵绊数。</div>
            </div>
            <div v-if="Number(baseBond) > 0" class="field">
              <label title="按倍率：排「加成百分比」最高的队伍；按牵绊点数：按「倍率 × 基础牵绊 + 固定数值加成」排。">结果排序（也是搜索目标）</label>
              <select v-model="sortMode">
                <option value="multiplier">按倍率（默认）</option>
                <option value="points">按牵绊点数</option>
              </select>
              <div class="text-muted">按倍率或按「倍率 × 基础牵绊 + 固定加成」排。</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 结果区：一级页面滚轮下滑查看 -->
      <div class="results-section panel">
        <div class="results-head">
          <h2>推荐结果（共 {{ totalCandidates }} 个，当前显示 {{ filteredResults.length }} 个）</h2>
          <div class="verification-actions">
            <button
              v-if="results.length && (verificationTokens.length || verificationTokensFull.length)"
              class="secondary"
              @click="copyVerificationCode"
              @contextmenu.prevent.stop="openVerificationModeMenu($event)"
              :title="'左键复制验证串；右键切换复现/完整模式。当前：' + (verificationMode === 'full' ? '完整模式（全量静态数据）' : '复现模式（默认，串较短）')"
            >
              📋 复制验证串（{{ verificationMode === 'full' ? '完整' : '复现' }}）<span v-if="activeVerificationTokens.length > 1">（{{ activeVerificationTokens.length }}段）</span>
            </button>
            <span v-if="verificationCopied" class="text-muted verification-copied">已复制</span>
            <button
              v-if="results.length"
              class="secondary"
              @click="copyFeedbackSummary"
              @contextmenu.prevent.stop="openFeedbackModeMenu($event)"
              :title="'左键复制反馈摘要；右键切换简短/完整模式。当前：' + (resultSettings.feedbackMode === 'full' ? '完整模式（含 Box/礼装池）' : '简短模式')"
            >
              📝 复制反馈摘要（{{ resultSettings.feedbackMode === 'full' ? '完整' : '简短' }}）
            </button>
            <button v-if="resultSettings.compareMode && compareSelectedRanks.length >= 2" class="secondary" @click="openCompare">📊 对比已选（{{ compareSelectedRanks.length }}）</button>
            <button v-if="compareSelectedRanks.length" class="secondary" @click="compareSelectedRanks = []">清空选择</button>
          </div>
          <div v-if="simpleExcludedServants.length" class="simple-exclusions">
            <button class="secondary" :disabled="calculating" @click="calculate">🔁 重新计算</button>
            <span class="text-muted">简易排除：</span>
            <span
              v-for="sid in simpleExcludedServants"
              :key="sid"
              class="simple-exclusion-chip"
              :title="(servantMap[sid] ? servantMap[sid].name : sid) + '（点击取消排除）'"
              @click="toggleSimpleExclude(sid)"
            >
              <img v-if="!avatarMissingSet.has(String(sid))" :src="avatarPath(sid)" class="simple-exclusion-avatar" alt="" @error="markAvatarBroken(sid)" />
              <span v-else class="simple-exclusion-avatar fallback">{{ (servantMap[sid] ? servantMap[sid].name : '?').charAt(0) }}</span>
            </span>
          </div>
        </div>
        <div v-if="loadedResultInfo" class="search-stats" :class="{ warn: loadedResultInfo.stale }">
          📂 {{ loadedResultInfo.presetName }}<template v-if="loadedResultInfo.savedAt"> · {{ loadedResultInfo.savedAt }}</template>
          <span v-if="loadedResultInfo.stale"> · 数据已更新，建议重算</span>
        </div>
        <div v-if="lastSearchStats && lastSearchStats.superLevel" class="search-stats">
          🚀 超级模式 ×{{ lastSearchStats.superLevel }}：不设时间上限、按最大范围搜索
          <span class="text-muted">（范围越大越慢；中途点"停止"已算出的结果会保留）</span>
        </div>
        <div v-if="lastSearchStats && lastSearchStats.partial" class="search-stats warn">
          ⏹ 你在中途点了停止：下面是**已经算出来并排好序**的部分结果，没有丢
        </div>
        <div v-if="lastSearchStats && lastSearchStats.truncated && !lastSearchStats.partial" class="search-stats warn">
          ⚠️ 本次搜索被时间上限截断（还没算完）：换更高的「计算质量」档位可能找到更好的队伍
        </div>
        <div v-if="resultSettings.showSearchStats && lastSearchStats" class="search-stats text-muted">
          🔍 本次搜索：{{ qualityModeText(lastSearchStats.qualityMode) }}
          · 用时 {{ lastSearchStats.elapsed }}s
          · 候选 {{ lastSearchStats.poolSize || 0 }} 人
          · 已按分数从高到低核对 {{ formatCount(lastSearchStats.processed) }} 支队伍
          <span :title="'排名靠前的队伍都在这批里；被跳过的是分数上限低于当前榜尾、挤不进现有名次的那批（本次池内共 ' + formatCount(lastSearchStats.poolCombos || 0) + ' 支组合）。范围越大越慢，可调「计算质量」或开「超级模式」。'">ⓘ</span>
        </div>
        <div v-if="resultSettings.showDataVersion" class="search-stats text-muted">
          客户端 v{{ info && info.version ? info.version : '?' }} · 数据更新 {{ info && info.dataUpdatedAt ? info.dataUpdatedAt : '未知' }} · 数据区 {{ info && info.dataRegion ? info.dataRegion : 'JP' }}
        </div>
        <div v-if="!results.length" class="empty">点击“开始计算”后结果会显示在这里</div>
        <div v-else-if="!filteredResults.length" class="empty">当前 Top 结果都包含被简易排除的从者，请点击上方“🔁 重新计算”搜索替代队伍</div>
        <div v-for="r in pagedResults" :key="r.rank" class="result-card">
          <div class="head">
            <strong>方案 #{{ r.rank }} ⭐ {{ r.totalMultiplier.toFixed(3) }}x</strong>
            <span v-if="showsBondPoints(r)" class="text-muted"><template v-if="r.baseBond">基础 {{ formatBondNumber(r.baseBond) }} → </template>预计总牵绊 {{ formatBondNumber(r.totalBondPoints) }}</span>
            <span class="text-muted" :title="sameScoreActive(r) ? '这一支的 Cost（同分替补的从者不同，Cost 会跟着变）' : ''">Cost {{ resultCostUsed(r) }}/{{ costLimit }}</span>
            <label class="compare-toggle" title="勾选后可多选方案用于“复制反馈摘要”或方案对比">
              <input type="checkbox" :checked="compareSelectedRanks.includes(r.rank)" @change="toggleCompareResult(r)" />
              选择
            </label>
            <span style="flex:1"></span>
            <button
              v-if="sameScoreCount(r) > 1"
              class="secondary same-score-toggle"
              :class="{ open: expandedSameScore === r.rank }"
              :title="'本行有 ' + sameScoreCount(r) + ' 支「同分可替换」阵容（分数完全相同）；点开可看全部，点其中一支即可让它在本行显示'"
              @click="expandedSameScore = (expandedSameScore === r.rank ? null : r.rank)"
            >
              {{ expandedSameScore === r.rank ? '▴' : '▾' }} 同分 {{ sameScoreCount(r) }} 支
            </button>
            <button class="secondary" @click="expandedResult = (expandedResult === r ? null : r)">详情</button>
            <button class="secondary" @click="exportJson(r)">导出JSON</button>
          </div>
          <div v-if="expandedSameScore === r.rank && sameScoreCount(r) > 1" class="same-score-panel">
            <div class="same-score-hint text-muted">
              {{ sameScoreCount(r) }} 支分数完全相同（{{ Number(r.totalMultiplier).toFixed(3) }}x），点一支让它在本行显示<template
                v-if="sameScoreHiddenCount(r) > 0">；{{ sameScoreHiddenCount(r) }} 支含已排除从者已隐藏</template>
            </div>
            <div v-for="sec in sameScoreSections(r)" :key="sec.key" class="same-score-section">
              <div class="same-score-section-label text-muted">{{ sec.label }}</div>
              <template v-for="item in sec.items" :key="item.index">
              <div v-if="item.subLabel" class="same-score-sublabel text-muted">{{ item.subLabel }}</div>
              <div
                class="same-score-item"
                :class="{ active: sameScoreChoiceIndex(r) === item.index }"
                @click="chooseSameScore(r, item.index)"
              >
                <span v-if="sameScoreChoiceIndex(r) === item.index" class="same-score-badge">显示中</span>
                <span class="same-score-team">
                  <span v-for="grp in sameScoreRows(r, item.alt)" :key="grp.label" class="same-score-rowgroup">
                    <span class="same-score-rowlabel text-muted">{{ grp.label }}</span>
                    <span
                      v-for="m in grp.members"
                      :key="m.position"
                      class="same-score-avatar"
                      :class="{ changed: m.changed }"
                      :title="m.name + '（' + m.posLabel + '）' + (m.craftName ? '｜主礼装：' + m.craftName : '') + (m.secondCraftName ? '｜第二礼装位：' + m.secondCraftName : '')"
                    >
                      <img
                        v-if="!avatarMissingSet.has(String(m.servantId))"
                        :src="avatarPath(m.servantId)"
                        alt=""
                        @error="markAvatarBroken(m.servantId)"
                      />
                      <span v-else class="same-score-avatar-fallback">{{ (m.name || '?').charAt(0) }}</span>
                    </span>
                  </span>
                </span>
                <span v-if="sameScoreChoiceIndex(r) === item.index" class="same-score-badge">显示中</span>
              </div>
              </template>
            </div>
            <div v-if="sameScoreCollapsedCount(r) > 0" class="same-score-more">
              <button class="secondary" @click="toggleSameScoreExpand(r)">
                展开其余 {{ sameScoreCollapsedCount(r) }} 支
              </button>
            </div>
            <div v-else-if="sameScoreExpandable(r)" class="same-score-more">
              <button class="secondary" @click="toggleSameScoreExpand(r)">
                收起（只看最少改动的前 {{ sameScoreCollapseLimit() }} 支）
              </button>
            </div>
          </div>
          <div class="result-board">
            <div v-for="m in visibleResultTeam(r)" :key="m.position" class="result-col">
              <div class="mini-cell mini-servant" :class="{ support: m.isSupport, fixed: m.isFixed, crown: m.isCrown }" @contextmenu="openResultContext($event, r, m, 'servant')">
                <img v-if="!avatarMissingSet.has(String(m.servantId))" :src="avatarPath(m.servantId)" class="mini-avatar" alt="" @error="markAvatarBroken(m.servantId)" />
                <div v-else class="mini-avatar fallback">{{ (m.name || '?').charAt(0) }}</div>
                <div class="mini-stage">{{ stageNumber(m.stage) }}</div>
                <div
                  v-if="resultSettings.showResultBondBadge && resultBondInfo(m)"
                  class="bond-badge mini-bond-badge"
                  :class="resultBondInfo(m).kind"
                  :title="'牵绊 ' + resultBondInfo(m).text + '（阶段：' + resultMemberStage(m) + '）'"
                >{{ resultBondInfo(m).text }}</div>
                <div v-if="m.isSupport" class="mini-support">助战</div>
                <div v-if="m.isFixed" class="mini-fixed">🔒</div>
                <div v-if="m.isCrown" class="mini-crown-star" title="冠位从者位">✴</div>
              </div>
              <div v-for="(cm, ci) in visibleResultCraftItems(m)" :key="'craft-' + cm.index" class="mini-craft-wrap">
                <div
                  class="mini-cell mini-craft"
                  :class="{ second: cm.index === 1, 'no-img': !cm.hasImage }"
                  @contextmenu="openResultContext($event, r, m, 'craft', cm.index)"
                >
                  <img v-if="cm.hasImage" :src="craftImagePathId(cm.craftId)" class="mini-craft-img" alt="" />
                  <span class="mini-craft-name">{{ cm.craftName || '无礼装' }}</span>
                </div>
                <!-- 加成/牵绊文本移到格子外面单独一行；冠位从者有两个礼装格，只在**最后一个格子**下面显示一次
                     （格子是正方形且 overflow:hidden，塞在格内会被裁掉） -->
                <div v-if="!m.isSupport && ci === visibleResultCraftItems(m).length - 1" class="mini-craft-extra">
                  <span class="mini-mult">加成 x{{ m.bonusDetail.totalMultiplier.toFixed(2) }}</span>
                  <span v-if="showsBondPoints(r) && m.bonusDetail" class="mini-points">≈{{ formatBondNumber(m.bonusDetail.bondPoints) }} 绊</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="expandedResult === r" class="result-detail">
            <div v-if="sameScoreActive(r)" class="same-score-note">
              ℹ️ 本行显示的是「同分可替换」阵容里的第 {{ sameScoreChoiceIndex(r) + 1 }} 支（共 {{ sameScoreCount(r) }} 支，分数完全相同 {{ Number(r.totalMultiplier).toFixed(3) }}x）。
              站位沿用本行，礼装取这一支自己的配置（同一组里礼装相同，只是换了谁拿），<b>Cost 也随人变化</b>；
              若要换回引擎给的那一支，回列表点开「同分 {{ sameScoreCount(r) }} 支」再选。
            </div>
            <div class="detail-summary">
              <div class="summary-item"><span class="label">总倍率</span><span class="value">x{{ Number(r.totalMultiplier).toFixed(3) }}</span></div>
              <div v-if="showsBondPoints(r)" class="summary-item"><span class="label">预计总牵绊</span><span class="value">{{ formatBondNumber(r.totalBondPoints) }}</span></div>
              <div class="summary-item"><span class="label">Cost 使用</span><span class="value">{{ resultCostUsed(r) }}/{{ costLimit }}</span></div>
              <div class="summary-item"><span class="label">基础牵绊</span><span class="value">{{ formatBondNumber(r.baseBond || 0) }}</span></div>
              <div v-if="r.maxBondStats && r.maxBondStats.count" class="summary-item"><span class="label">满绊共享加成</span><span class="value">{{ r.maxBondStats.count }} 人 × 25%</span></div>
            </div>
            <table class="detail-table">
              <thead>
                <tr>
                  <th>位置</th>
                  <th>从者</th>
                  <th>阶段</th>
                  <th>礼装</th>
                  <th>加成明细</th>
                  <th>个人倍率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in visibleResultTeam(r)" :key="m.position" :class="{ 'support-row': m.isSupport }">
                  <td data-label="位置">
                    <div>{{ positionLabel(m.position) }}</div>
                    <div class="detail-meta">
                      <span v-if="m.isSupport" class="detail-tag" style="color:var(--support);border-color:var(--support)">助战</span>
                      <span v-if="m.isCrown" class="detail-tag" style="color:#4fc3f7;border-color:#4fc3f7">冠位</span>
                      <span v-if="m.isFixed" class="detail-tag" style="color:var(--danger);border-color:var(--danger)">固定</span>
                    </div>
                  </td>
                  <td data-label="从者">
                    <div class="detail-craft-name">{{ m.name || (servantMap[m.servantId] ? servantMap[m.servantId].name : '') || m.servantId }}</div>
                    <div class="text-muted">{{ resultMemberClass(m) }}</div>
                  </td>
                  <td data-label="阶段">{{ resultMemberStage(m) }}</td>
                  <td data-label="礼装">
                    <div v-for="cm in resultCraftItems(m)" :key="cm.index" class="detail-craft-detail">
                      <span class="detail-craft-name">{{ cm.craftName || '无礼装' }}</span>
                      <span v-if="cm.index === 1" class="detail-tag">第二礼装</span>
                    </div>
                    <div v-if="resultSettings.showCostBreakdown && !m.isSupport" class="text-muted detail-extra-line">{{ resultCostBreakdown(m) }}</div>
                  </td>
                  <td data-label="加成明细">
                    <div v-if="m.isSupport" class="text-muted">助战不参与个人收益</div>
                    <div v-else-if="m.bonusDetail" class="detail-bonus-chips">
                      <span v-for="bp in resultBonusParts(m)" :key="bp.label" class="chip">{{ bp.label }} {{ bp.value }}</span>
                    </div>
                    <div v-if="resultSettings.showBonusFormula && !m.isSupport && m.bonusDetail" class="formula-line">{{ resultBonusFormula(m) }}</div>
                    <div v-if="!m.isSupport && m.craftBonusDetails && m.craftBonusDetails.length" class="craft-breakdown">
                      <div v-for="(d, di) in m.craftBonusDetails" :key="'bd-' + di" class="craft-breakdown-item">
                        {{ craftBonusDetailText(d) }}
                      </div>
                    </div>
                  </td>
                  <td data-label="个人倍率">
                    <template v-if="!m.isSupport && m.bonusDetail">
                      <div style="font-weight:700;color:var(--ok)">x{{ m.bonusDetail.totalMultiplier.toFixed(3) }}</div>
                      <div v-if="showsBondPoints(r)" class="text-muted">≈{{ formatBondNumber(m.bonusDetail.bondPoints) }} 绊</div>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="r.traitCoverage && r.traitCoverage.length" class="detail-extra">
              <div style="margin-bottom:4px;font-weight:600">命中的特性礼装条件</div>
              <div class="trait-info">
                <span v-for="t in r.traitCoverage" :key="t" class="trait-chip">{{ traitLabel(t) }}</span>
              </div>
            </div>
            <div v-if="resultTeamCrafts(r).length" class="detail-extra">
              <div style="margin-bottom:4px;font-weight:600">队伍礼装说明</div>
              <div v-for="c in resultTeamCrafts(r)" :key="c.id" class="detail-craft-detail" style="margin-bottom:4px">
                <span class="detail-craft-name">{{ c.name }}</span>
                <span v-if="c.cost !== undefined" class="text-muted">（Cost {{ c.cost }}）</span>
                <span v-if="resultSettings.showCraftTriggers && c.bonusType === 'trait'" class="text-muted">：{{ traitGroupsText(c) }}</span>
                <div v-if="resultSettings.showCraftHits && c.bonusType === 'trait'" class="text-muted">命中：{{ craftHitMembers(r, c.id) }}</div>
                <div class="text-muted">{{ c.detail || '' }}</div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="filteredResults.length > pageSize" class="pagination">
          <button class="secondary" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">上一页</button>
          <span class="text-muted">第 {{ currentPage }} / {{ totalPages }} 页 · 每页 {{ pageSize }} 条 · 共 {{ filteredResults.length }} 条</span>
          <button class="secondary" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">下一页</button>
        </div>
      </div>
    </template>

    <!-- 选择覆盖层 -->
    <div v-if="overlay.visible" class="overlay-mask" @click.self="closeOverlay">
      <div class="overlay-panel" :class="overlay.target === 'servant' ? 'servant-overlay-panel' : ''">
        <div class="overlay-head">
          <h2>{{ overlay.target === 'servant' ? '选择从者' : '选择礼装' }}</h2>
          <button class="secondary" @click="closeOverlay">✕</button>
        </div>
        <div class="filters">
          <input v-model="overlay.keyword" placeholder="搜索" />
          <select v-if="overlay.target === 'servant'" v-model="overlay.classFilter">
            <option value="all">全部职阶</option>
            <option v-for="c in classOptions" :key="c" :value="c">{{ c }}</option>
          </select>
          <select v-if="overlay.target === 'servant'" v-model="overlay.rarityFilter">
            <option value="all">全部星级</option>
            <option v-for="n in [1,2,3,4,5]" :key="n" :value="n">{{ n }}★</option>
          </select>
          <select v-else v-model="overlay.craftType">
            <option value="bond">牵绊礼装</option>
            <option value="other">其他礼装</option>
          </select>
          <template v-if="overlay.target === 'servant'">
            <select v-model="overlay.sortBy" title="排序方式">
              <option value="collectionNo">按序号</option>
              <option value="bond">按牵绊数值</option>
            </select>
            <button class="secondary" @click="overlay.sortOrder = overlay.sortOrder === 'desc' ? 'asc' : 'desc'">{{ overlay.sortOrder === 'desc' ? '↓ 倒序' : '↑ 正序' }}</button>
          </template>
        </div>
        <div class="overlay-grid" :class="overlay.target === 'servant' ? 'servant-grid' : ''">
          <div
            v-for="item in overlayItems"
            :key="item.id"
            class="pick-card"
            :class="overlay.target === 'servant' ? 'servant-pick' : ''"
            @click="overlay.target === 'servant' ? chooseServant(overlay.slotIndex, item.id) : chooseCraft(overlay.slotIndex, item.id, overlay.craftIndex || 0)"
            @contextmenu.prevent="overlay.target === 'servant' ? openOverlayServantContext($event, item) : (overlay.target === 'craft' ? toggleCraftAutoParticipation(item) : null)"
            @mouseenter="overlay.target === 'servant' ? showHover($event, item) : null"
            @mousemove="overlay.target === 'servant' ? moveHover($event) : null"
            @mouseleave="hideHover"
          >
            <div v-if="overlay.target === 'craft' && item.craftType === 'bond' && !isCraftParticipating(item)" class="pick-not-participate">不参与自动</div>
            <div v-if="overlay.target === 'servant' && overlay.sortBy === 'bond'" class="bond-badge" :class="servantBondInfo(item) ? servantBondInfo(item).kind : ''">{{ servantBondInfo(item) ? servantBondInfo(item).text : '' }}</div>
            <img v-if="overlay.target === 'servant' && !avatarMissingSet.has(String(item.id))" :src="avatarPath(item.id)" class="pick-avatar" alt="" @error="markAvatarBroken(item.id)" />
            <div v-else-if="overlay.target === 'servant'" class="pick-name">{{ item.name.charAt(0) }}</div>
            <template v-if="overlay.target === 'craft'">
              <img v-if="hasCraftImage(item)" :src="craftImagePath(item)" class="pick-craft-img" alt="" />
              <div class="pick-name">{{ item.name }}</div>
            </template>
            <div class="pick-meta">{{ overlay.target === 'servant' ? item.class : (item.rarity + '★') }} / Cost {{ item.cost }}</div>
            <div v-if="overlay.target === 'craft'" class="pick-detail" :title="item.detail || item.name">{{ item.detail || '' }}</div>
          </div>
          <div v-if="!overlayItems.length" class="empty">没有可选内容</div>
        </div>
      </div>
    </div>

    <!-- Box 管理弹窗 -->
    <div v-if="boxModalVisible" class="modal-mask" @click.self="boxModalVisible = false">
      <div class="modal-panel box-modal">
        <div class="overlay-head">
          <h2>Box 管理</h2>
          <button class="secondary" @click="boxModalVisible = false">✕</button>
        </div>
        <div class="filters">
          <input v-model="boxFilter.keyword" placeholder="搜索从者" />
          <select v-model="boxFilter.class"><option value="all">全部职阶</option><option v-for="c in classOptions" :key="c" :value="c">{{ c }}</option></select>
          <select v-model="boxFilter.rarity"><option value="all">全部星级</option><option v-for="n in [1,2,3,4,5]" :key="n" :value="n">{{ n }}★</option></select>
          <select v-model="boxFilter.owned"><option value="all">持有：全部</option><option value="owned">持有</option><option value="notOwned">未持有</option></select>
          <select v-model="boxFilter.maxBond"><option value="all">牵绊筛选：全部</option><option value="max">满绊</option><option value="notMax">未满绊</option></select>
          <button class="secondary" @click="openBatchModal">批量设置加成</button>
          <button class="secondary" @click="resetBox">恢复Box默认</button>
          <button class="secondary" @click="triggerCaptureImport">导入抓包数据</button>
        </div>
        <input ref="captureInput" type="file" accept=".php,.txt,.json,application/json" style="display:none" @change="onCaptureFile" />
        <div class="box-grid">
          <div
            v-for="s in boxGridServants"
            :key="s.id"
            class="box-cell"
            :data-cell-id="s.id"
            :class="{ owned: cellState('owned', s.id) }"
            @mousedown="onCellDragStart($event, 'owned', s.id)"
            @touchstart="onCellTouchStart($event, 'owned', s.id)"
            @click="toggleOwned(s.id)"
            @contextmenu="openBoxContext($event, s)"
            @mouseenter="showHover($event, s)"
            @mousemove="moveHover($event)"
            @mouseleave="hideHover"
          >
            <img v-if="!avatarMissingSet.has(String(s.id))" :src="avatarPath(s.id)" :alt="s.name" class="box-avatar" draggable="false" @error="markAvatarBroken(s.id)" />
            <div v-else class="box-avatar fallback">{{ s.name.charAt(0) }}</div>
            <div v-if="cellState('owned', s.id)" class="box-owned-mark">✔</div>
            <div class="box-sn">{{ s.collectionNo }}</div>

            <div v-if="cellState('owned', s.id)" class="box-maxbond" :class="{ active: box[s.id].maxBond && box[s.id].switch1, full: box[s.id].maxBond && !box[s.id].switch1 }" @click.stop="toggleMaxBond(s.id)" :title="box[s.id].maxBond ? (box[s.id].switch1 ? '满绊 · 参与25%全队加成' : '满绊 · 未启用25%加成') : '满绊标记'">绊</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 批量设置加成（第3级页面） -->
    <div v-if="batchModalVisible" class="modal-mask" @click.self="batchModalVisible = false">
      <div class="modal-panel box-modal">
        <div class="overlay-head">
          <h2>批量设置个人加成</h2>
          <button class="secondary" @click="batchModalVisible = false">✕</button>
        </div>
        <div class="field">
          <label>按活动导入牵绊加成</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select v-model="selectedEventId" style="flex:1;min-width:220px">
              <option value="">请选择活动</option>
              <option v-for="ev in eventBondEvents" :key="ev.eventId" :value="ev.eventId">{{ ev.eventName }}</option>
            </select>
            <button class="secondary" @click="importEventBonus">导入（先清空原加成）</button>
            <button class="secondary" @click="resetAllPersonalBonus">恢复默认（全部0）</button>
          </div>
          <div v-if="batchImportMessage" class="text-muted" style="margin-top:4px">{{ batchImportMessage }}</div>
        </div>
        <div class="field"><label>个人加成（%）</label><input type="number" min="0" step="0.01" v-model.number="batchBonus" /></div>
        <div class="text-muted" style="margin-bottom:6px">已选 {{ batchSelectedServants.length }} / {{ ownedServants.length }} 位持有从者</div>
        <div class="box-grid">
          <div
            v-for="s in ownedServants"
            :key="s.id"
            class="box-cell"
            :data-cell-id="s.id"
            :class="{ owned: cellState('batch', s.id) }"
            @mousedown="onCellDragStart($event, 'batch', s.id)"
            @touchstart="onCellTouchStart($event, 'batch', s.id)"
            @click="toggleBatchSelect(s.id)"
            @contextmenu="openBoxContext($event, s)"
            @mouseenter="showHover($event, s)"
            @mousemove="moveHover($event)"
            @mouseleave="hideHover"
          >
            <img v-if="!avatarMissingSet.has(String(s.id))" :src="avatarPath(s.id)" :alt="s.name" class="box-avatar" draggable="false" @error="markAvatarBroken(s.id)" />
            <div v-else class="box-avatar fallback">{{ s.name.charAt(0) }}</div>
            <div v-if="cellState('batch', s.id)" class="box-owned-mark">✔</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="secondary" @click="selectAllOwned">全选</button>
          <button class="secondary" @click="batchSelectedServants = []">取消当前选择</button>
          <button class="primary" @click="applyBatchBonus">应用加成</button>
        </div>
      </div>
    </div>

    <!-- 自定义礼装管理弹窗 -->
    <div v-if="customModalVisible" class="modal-mask" @click.self="closeCustomManager">
      <div class="modal-panel box-modal custom-modal">
        <div class="overlay-head">
          <h2>自定义礼装</h2>
          <button class="secondary" @click="closeCustomManager">✕</button>
        </div>
        <div class="custom-manager-layout">
          <div class="custom-list">
            <button class="primary" style="margin-bottom:8px;width:100%" @click="newCustomCraft">＋ 新建礼装</button>
            <div v-if="!customCrafts.length" class="empty">暂无自定义礼装</div>
            <div v-for="c in customCrafts" :key="c.id" class="list-row custom-row" :class="{ disabled: !c.enabled }">
              <div style="flex:1;min-width:0">
                <div>
                  {{ c.name }}
                  <span class="tag">{{ c.craftType === 'bond' ? '牵绊' : '其他' }}</span>
                  <span v-if="!c.enabled" class="tag off">停用</span>
                </div>
                <div class="text-muted small" style="margin-top:2px">{{ customCraftDetail(c) }}</div>
              </div>
              <button class="secondary" @click="editCustomCraft(c)">编辑</button>
              <button class="secondary" @click="toggleCustomCraft(c)">{{ c.enabled ? '停用' : '启用' }}</button>
              <button class="secondary danger" @click="deleteCustomCraft(c)">删除</button>
            </div>
          </div>
          <div v-if="customDraft" class="custom-editor">
            <div class="overlay-head">
              <h3>{{ customEditing ? '编辑礼装' : '新建礼装' }}</h3>
            </div>
            <div class="field"><label>名称</label><input v-model.trim="customDraft.name" placeholder="礼装名称" /></div>
            <div class="field">
              <label>类型</label>
              <select v-model="customDraft.craftType">
                <option value="bond">牵绊礼装（参与引擎搜索/加成）</option>
                <option value="other">其他礼装（手动占位/Cost，不参与加成搜索）</option>
              </select>
            </div>
            <div class="custom-fields-row">
              <div class="field"><label>Cost</label><input type="number" min="0" max="99" v-model.number="customDraft.cost" /></div>
              <div class="field"><label>星级</label><input type="number" min="0" max="5" v-model.number="customDraft.rarity" /></div>
            </div>
            <template v-if="customDraft.craftType === 'bond'">
              <div class="custom-fields-row">
                <div class="field"><label>百分比加成（%）</label><input type="number" min="0" step="0.1" v-model.number="customDraft.percentBonus" /></div>
                <div class="field"><label>固定数值加成</label><input type="number" min="0" step="1" v-model.number="customDraft.flatBonus" /></div>
              </div>
              <div class="field">
                <label>
                  <input type="checkbox" v-model="customDraft.repeatable" style="width:auto;margin-right:6px" />
                  可以重复布置（同一张自定义礼装可放多个格子）
                </label>
              </div>
              <div class="field">
                <label>加成条件</label>
                <div style="display:flex;gap:6px;margin-bottom:6px">
                  <button class="secondary" :class="{ active: !customDraft.conditionGroups.length }" @click="customSetUnconditional">无条件</button>
                  <button class="secondary" :class="{ active: customDraft.conditionGroups.length }" @click="customSetConditional">按条件</button>
                </div>
                <div class="text-muted small">同一组内 = “且”，不同组之间 = “或”</div>
              </div>
              <div v-if="customDraft.conditionGroups.length" class="condition-groups">
                <div v-for="(group, gi) in customDraft.conditionGroups" :key="gi" class="condition-group">
                  <div class="condition-group-head">
                    <span>条件组 {{ gi + 1 }}</span>
                    <button class="secondary" @click="customRemoveGroup(gi)">删除组</button>
                  </div>
                  <div class="trait-chips">
                    <span v-for="tk in group" :key="tk" class="trait-chip">
                      {{ traitLabel(tk) }}
                      <button type="button" class="chip-x" @click="customRemoveTrait(gi, tk)">×</button>
                    </span>
                  </div>
                  <div class="trait-add-row">
                    <input v-model="customTraitInputs[gi]" list="custom-trait-options" placeholder="输入/选择特性，如 杀阶" @keyup.enter="customAddTrait(gi)" />
                    <button class="secondary" @click="customAddTrait(gi)">添加条件</button>
                  </div>
                </div>
                <button class="secondary" @click="customAddGroup">＋ 添加“或”条件组</button>
              </div>
            </template>
            <div class="custom-editor-actions">
              <button class="secondary" @click="customCancelEdit">取消</button>
              <button class="primary" @click="saveCustomCraft">保存礼装</button>
            </div>
          </div>
        </div>
        <datalist id="custom-trait-options">
          <option v-for="t in traitNameOptions" :key="t.key" :value="t.label">{{ t.key }}</option>
        </datalist>
      </div>
    </div>

    <!-- 排除管理弹窗 -->
    <div v-if="exclusionModalVisible" class="modal-mask" @click.self="exclusionModalVisible = false">
      <div class="modal-panel box-modal exclusion-modal">
        <div class="overlay-head">
          <h2>排除管理（不修改导入数据，仅不参与自动计算）</h2>
          <button class="secondary" @click="exclusionModalVisible = false">✕</button>
        </div>
        <div class="filters">
          <button class="secondary" :class="{ active: exclusionTab === 'servant' }" @click="exclusionTab = 'servant'">排除从者</button>
          <button class="secondary" :class="{ active: exclusionTab === 'craft' }" @click="exclusionTab = 'craft'">排除礼装</button>
        </div>
        <div v-if="exclusionTab === 'servant'" class="filters">
          <input v-model="exclusionKeyword" placeholder="搜索从者" />
          <select v-model="exclusionClass"><option value="all">全部职阶</option><option v-for="c in classOptions" :key="c" :value="c">{{ c }}</option></select>
          <select v-model="exclusionRarity"><option value="all">全部星级</option><option v-for="n in [1,2,3,4,5]" :key="n" :value="n">{{ n }}★</option></select>
          <select v-model="exclusionMaxBond"><option value="all">牵绊筛选：全部</option><option value="max">满绊</option><option value="notMax">未满绊</option></select>
          <select v-model="exclusionSortBy" title="排序方式">
            <option value="collectionNo">按序号</option>
            <option value="bond">按牵绊数值</option>
          </select>
          <button class="secondary" @click="exclusionSortOrder = exclusionSortOrder === 'desc' ? 'asc' : 'desc'">{{ exclusionSortOrder === 'desc' ? '↓ 倒序' : '↑ 正序' }}</button>
        </div>
        <div v-else class="filters">
          <input v-model="exclusionCraftKeyword" placeholder="搜索礼装" />
        </div>
        <div style="display:flex;gap:8px;margin:8px 0">
          <button class="secondary" @click="selectAllExclusion">全选当前列表</button>
          <button class="secondary" @click="clearCurrentExclusion">取消当前选择</button>
          <span class="text-muted">已排除：{{ exclusionTab === 'servant' ? excludedServants.length : excludedCrafts.length }} 项</span>
        </div>
        <div v-if="exclusionTab === 'servant'" class="exclusion-grid">
          <div
            v-for="s in filteredExclusionServants"
            :key="s.id"
            class="box-cell exclusion-cell"
            :data-cell-id="s.id"
            :class="{ 'exclusion-active': cellState('exclusion', s.id) }"
            @mousedown="onCellDragStart($event, 'exclusion', s.id)"
            @touchstart="onCellTouchStart($event, 'exclusion', s.id)"
            @click="toggleExcludeServant(s.id)"
            :title="s.name"
          >
            <img v-if="!avatarMissingSet.has(String(s.id))" :src="avatarPath(s.id)" class="box-avatar" alt="" draggable="false" @error="markAvatarBroken(s.id)" />
            <div v-else class="box-avatar fallback">{{ s.name.charAt(0) }}</div>
            <div v-if="exclusionSortBy === 'bond' && servantBondInfo(s)" class="bond-badge exclusion-bond-badge" :class="servantBondInfo(s).kind" :title="servantBondInfo(s).text">{{ servantBondInfo(s).text }}</div>
            <div v-else-if="exclusionSortBy !== 'bond'" class="box-maxbond exclusion-maxbond" :class="{ active: box[s.id].maxBond && box[s.id].switch1, full: box[s.id].maxBond && !box[s.id].switch1 }" :title="box[s.id].maxBond ? (box[s.id].switch1 ? '满绊 · 参与25%全队加成' : '满绊 · 未启用25%加成') : '满绊标记'">绊</div>
            <div class="exclusion-check">{{ cellState('exclusion', s.id) ? '✓' : '' }}</div>
          </div>
          <div v-if="!filteredExclusionServants.length" class="empty">没有可排除的从者</div>
        </div>
        <div v-else class="exclusion-grid craft-exclusion-grid">
          <div
            v-for="c in filteredExclusionCrafts"
            :key="c.id"
            class="craft-cell exclusion-cell"
            :class="{ 'exclusion-active': isExcludedCraft(c.id) }"
            @click="toggleExcludeCraft(c.id)"
            :title="c.name + ' / ' + (c.detail || '')"
          >
            <img v-if="hasCraftImage(c)" :src="craftImagePath(c)" class="craft-img" alt="" />
            <div v-else class="craft-fallback">{{ c.name }}</div>
            <div class="exclusion-check">{{ isExcludedCraft(c.id) ? '✓' : '' }}</div>
          </div>
          <div v-if="!filteredExclusionCrafts.length" class="empty">没有可排除的礼装</div>
        </div>
      </div>
    </div>

    <!-- 队伍配置弹窗 -->
    <div v-if="teamModalVisible" class="modal-mask" @click.self="teamModalVisible = false">
      <div class="modal-panel small">
        <div class="overlay-head"><h2>队伍配置</h2><button class="secondary" @click="teamModalVisible = false">✕</button></div>
        <div class="field"><label>Cost上限</label><input type="number" min="50" max="200" v-model.number="costLimit" /></div>
        <div class="field">
          <label>策略</label>
          <select v-model="strategy">
            <option value="total_max">总牵绊最大化</option>
            <option value="target_max">指定从者最大化</option>
            <option value="balanced">均衡模式</option>
          </select>
        </div>
        <div class="field">
          <label>计算质量 / 等待时间</label>
          <select v-model="qualityMode">
            <option value="fast">快速（约 35 秒上限）</option>
            <option value="standard">标准（约 60 秒上限）</option>
            <option value="balanced">平衡（默认，约 90 秒上限）</option>
            <option value="high">高质量（约 135 秒上限）</option>
            <option value="extreme">极限精算（约 300 秒上限，同高质量）</option>
          </select>
          <div class="text-muted">
            实际耗时主要看下面的「结果最多计算数量」；档位只决定引擎的搜索量和等待上限（算完就返回）。
          </div>
        </div>
        <div class="field">
          <label>结果最多计算数量</label>
          <select v-model.number="resultSettings.resultTopN" @change="persistResultSettings">
            <option :value="20">20 条（最快）</option>
            <option :value="50">50 条（快）</option>
            <option :value="100">100 条</option>
            <option :value="200">200 条（默认）</option>
            <option :value="500">500 条（慢）</option>
            <option :value="1000">1000 条（最慢）</option>
          </select>
          <div class="text-muted">
            这个数字也是引擎的"搜索止损线"：条数越多，剪枝生效得越晚 → 算得越慢（最多能差十几倍）。
            20~50 条几秒出结果；200 条约半分钟；500/1000 可能被时间预算截断。
          </div>
        </div>
        <div v-if="strategy === 'target_max'" class="field">
          <label>指定从者</label>
          <input v-model="targetServantKeyword" placeholder="搜索从者名称" />
          <div class="target-list">
            <button
              v-for="s in targetServantCandidates"
              :key="s.id"
              :class="{ active: targetServantId === s.id }"
              @click="targetServantId = s.id"
            >
              {{ s.name }}
              <span class="text-muted">{{ s.class }} / {{ s.rarity }}★ / {{ s.collectionNo }}</span>
            </button>
            <div v-if="!targetServantCandidates.length" class="empty">没有匹配从者</div>
          </div>
          <div v-if="targetServantId && servantMap[targetServantId]" class="text-muted" style="margin-top:6px">
            当前指定：{{ servantMap[targetServantId].name }}
          </div>
        </div>
      </div>
    </div>



    <!-- 保存预设弹窗 -->
    <div v-if="presetSaveVisible" class="modal-mask" @click.self="presetSaveVisible = false">
      <div class="modal-panel small">
        <div class="overlay-head"><h2>保存队伍</h2><button class="secondary" @click="presetSaveVisible = false">✕</button></div>
        <div class="field" style="margin:10px 0">
          <label>预设名称</label>
          <input v-model="presetName" placeholder="输入预设名称" @keyup.enter="confirmSavePreset" />
        </div>
        <label v-if="lastResultSnapshot" class="settings-row" style="margin:0 0 6px">
          <input type="checkbox" v-model="presetSaveWithResult" />
          <span>同时保存本次结果</span>
        </label>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="secondary" @click="presetSaveVisible = false">取消</button>
          <button class="primary" @click="confirmSavePreset">保存</button>
        </div>
      </div>
    </div>

    <!-- 预设面板 -->
    <div v-if="presetModalVisible" class="modal-mask" @click.self="presetModalVisible = false">
      <div class="modal-panel preset-panel">
        <div class="overlay-head"><h2>预设</h2><button class="secondary" @click="presetModalVisible = false">✕</button></div>
        <div v-if="!presets.length" class="empty">暂无预设</div>
        <div v-for="p in presets" :key="p.id" class="preset-item">
          <div class="preset-main">
            <input
              v-if="renamingPresetId === p.id"
              class="preset-rename-input"
              v-model="renameDraft"
              maxlength="40"
              placeholder="预设名称"
              @keyup.enter="confirmRenamePreset(p)"
              @keyup.esc="cancelRenamePreset"
              @blur="confirmRenamePreset(p)"
            />
            <template v-else>
              <div class="preset-name" :title="p.name">{{ p.name }}</div>
              <div class="preset-meta">
                <span class="badge-result" v-if="p.hasResult">含结果</span>
                <span class="preset-tag">{{ presetDateText(p) }}</span>
                <span class="preset-tag">{{ p.costLimit }} Cost</span>
                <span class="preset-tag" v-if="presetFixedText(p)">{{ presetFixedText(p) }}</span>
              </div>
            </template>
          </div>
          <button
            v-if="renamingPresetId !== p.id"
            class="preset-rename"
            @click="startRenamePreset(p)"
            title="重命名"
          >重命名</button>
          <button class="secondary" :disabled="renamingPresetId === p.id" @click="loadPreset(p)">加载</button>
          <button class="preset-del" @click="deletePreset(p)" title="删除">✕</button>
        </div>
      </div>
    </div>

    <!-- 更新数据弹窗 -->
    <div v-if="updateModalVisible" class="modal-mask" @click.self="closeUpdateModal">
      <div class="modal-panel box-modal update-modal">
        <div class="overlay-head">
          <h2>{{ updateTitle }}</h2>
          <button class="secondary" :disabled="updateRunning" @click="closeUpdateModal">✕</button>
        </div>
        <div v-if="updateTitle === '更新数据'" class="filters">
          <button class="secondary" :disabled="updateRunning" @click="runCheck()">检查刷新</button>
          <button class="secondary" :disabled="updateRunning" @click="runUpdate()">更新数据</button>
          <span class="text-muted" style="align-self:center">{{ updateStateText() }}</span>
        </div>
        <div v-if="updateTitle === '重置数据库'" class="text-muted" style="margin-bottom:10px">
          只重建静态数据（从者/礼装/特性/灵衣），账号 / Box / 排除 / 预设 / 自定义礼装都会保留；失败会自动回滚。
        </div>
        <!-- 版本与更新信息（点左上角「FGO牵绊推荐器」进入） -->
        <div v-if="updateTitle === '版本与更新信息'" class="version-panel">
          <div class="version-row">
            <span class="version-label">当前版本</span>
            <span>v{{ info && info.version ? info.version : '?' }}</span>
          </div>
          <div class="version-row">
            <span class="version-label">数据</span>
            <span class="text-muted">
              更新于 {{ info && info.dataUpdatedAt ? info.dataUpdatedAt : '未知' }}
              ｜ 数据区 {{ info && info.dataRegion ? info.dataRegion : 'JP' }}
            </span>
          </div>
          <div class="version-row" v-if="info && info.appRoot">
            <span class="version-label">程序目录</span>
            <span class="text-muted" style="word-break:break-all">{{ info.appRoot }}</span>
          </div>
          <div class="filters" style="margin-top:10px">
            <button class="secondary" :disabled="appUpdateChecking" @click="checkAppUpdate">
              {{ appUpdateChecking ? '正在检查…' : '🔍 检查软件更新' }}
            </button>
          </div>
          <div v-if="appUpdateError" class="panel error" style="margin-top:8px">{{ appUpdateError }}</div>
          <div v-if="appUpdate" class="app-update-result" :class="appUpdate.hasUpdate ? 'newer' : 'latest'">
            <template v-if="!appUpdate.ok">
              <div>⚠️ {{ appUpdate.message }}</div>
            </template>
            <template v-else-if="appUpdate.hasUpdate">
              <div class="app-update-title">🎉 发现新版本 v{{ appUpdate.latest }}（当前 v{{ appUpdate.current }}）</div>
              <div class="filters" style="margin-top:8px">
                <button class="primary" @click="openExternalLink(appUpdate.bilibiliUrl)">📣 关注动态及更新信息</button>
              </div>
              <pre v-if="appUpdate.notes" class="app-update-notes">{{ appUpdate.notes }}</pre>
            </template>
            <template v-else>
              <div class="app-update-title">✅ 已经是最新版本（v{{ appUpdate.current }}）</div>
              <div class="filters" style="margin-top:8px">
                <button class="secondary" @click="openExternalLink(appUpdate.bilibiliUrl)">📣 关注动态及更新信息</button>
              </div>
            </template>
            <div v-if="appUpdate.androidNote" class="text-muted" style="margin-top:6px">{{ appUpdate.androidNote }}</div>
          </div>
        </div>
        <div v-if="updateError" class="panel error" style="margin-bottom:10px">{{ updateError }}</div>
        <div v-if="updateTitle !== '版本与更新信息'" class="update-items">
          <div v-for="item in updateItems" :key="item.key" class="update-item" :class="item.status">
            <div class="update-status">{{ item.status === 'done' ? '✅' : (item.status === 'running' ? '⏳' : (item.status === 'error' ? '❌' : '○')) }}</div>
            <div class="update-main">
              <div class="update-label">{{ item.label }}</div>
              <div v-if="item.detail" class="update-detail">{{ item.detail }}</div>
              <div v-if="item.status === 'running' && item.percent !== null" class="update-track">
                <div class="update-bar" :style="{ width: Math.max(0, Math.min(100, item.percent)) + '%' }"></div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="updateResult && updateTitle !== '版本与更新信息'" class="update-result">
          <div class="text-muted" style="margin-bottom:4px">更新结果</div>
          <pre style="white-space:pre-wrap;font-size:12px;max-height:160px;overflow:auto">{{ JSON.stringify(updateResult, null, 2) }}</pre>
        </div>
      </div>
    </div>

    <!-- 从者详细设置 -->
    <div v-if="servantDetail.visible" class="modal-mask" @click.self="servantDetail.visible = false">
      <div class="modal-panel small">
        <div class="overlay-head">
          <h2>{{ servantDetail.servantId ? (servantMap[servantDetail.servantId] ? servantMap[servantDetail.servantId].name : '') : '' }} 设置</h2>
          <button class="secondary" @click="servantDetail.visible = false">✕</button>
        </div>
        <div v-if="servantDetail.servantId && box[servantDetail.servantId]" class="detail-form">
          <div v-if="servantDetail.slotIndex !== null" class="field">
            <label>固定阶段/灵衣</label>
            <select :value="slots[servantDetail.slotIndex].stage || ''" @change="setSlotStage(servantDetail.slotIndex, $event.target.value)">
              <option v-for="opt in servantStageOptions(servantDetail.slotIndex)" :key="opt.value || 'auto'" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div v-else class="text-muted" style="margin-bottom:8px">自由位/Box：灵基阶段与灵衣由引擎根据特性礼装自动选择</div>
          <div class="custom-fields-row">
            <div class="field">
              <label>当前牵绊等级</label>
              <input type="number" min="0" max="99" :value="box[servantDetail.servantId].bondRank || 0" @change="setBondRank(servantDetail.servantId, $event.target.value)" />
              <div class="text-muted" style="margin-top:2px">例如 7/10 填 7；满级可自动同步“满绊标记”。</div>
            </div>
            <div class="field">
              <label>牵绊等级上限</label>
              <input type="number" min="0" max="99" :value="box[servantDetail.servantId].bondMaxRank || 0" @change="setBondMaxRank(servantDetail.servantId, $event.target.value)" />
              <div class="text-muted" style="margin-top:2px">例如 10/10 填 10；15/15 填 15。</div>
            </div>
          </div>
          <div v-if="bondFlagsAuto(servantDetail.servantId)" class="text-muted" style="margin:4px 0 2px"
               title="Lv ≥ 15 ⇒ 给全队 25%；未达上限 ⇒ 自身照常计收益。想手勾请把等级填 0">
            按等级自动判定（Lv {{ box[servantDetail.servantId].bondRank }}/{{ box[servantDetail.servantId].bondMaxRank }}）
          </div>
          <label style="display:flex;gap:6px;margin:6px 0"><input type="checkbox" :checked="box[servantDetail.servantId].maxBond" :disabled="bondFlagsAuto(servantDetail.servantId)" @change="toggleMaxBond(servantDetail.servantId)" /> 满绊标记（达到当前牵绊上限）</label>
          <label style="display:flex;gap:6px;margin:6px 0"><input type="checkbox" :checked="box[servantDetail.servantId].switch1" :disabled="bondFlagsAuto(servantDetail.servantId) || !box[servantDetail.servantId].maxBond" @change="toggleSwitch1(servantDetail.servantId)" /> 全队25%加成（Lv 15 及以上）</label>
          <label style="display:flex;gap:6px;margin:6px 0"><input type="checkbox" :checked="box[servantDetail.servantId].switch2" :disabled="bondFlagsAuto(servantDetail.servantId) || !box[servantDetail.servantId].maxBond" @change="toggleSwitch2(servantDetail.servantId)" /> 开关二（满绊也计自身收益）</label>
          <div class="field">
            <label>个人加成（%）</label>
            <input type="number" min="0" step="0.01" :value="box[servantDetail.servantId].personalBonus" @change="setPersonal(servantDetail.servantId, $event.target.value)" />
          </div>
          <div v-if="Number(servantDetail.servantId) === 800100" class="field">
            <label>玛修全队光环（%）</label>
            <input type="number" min="0" step="0.01" :value="box[servantDetail.servantId].auraBonus" @change="setAura(servantDetail.servantId, $event.target.value)" />
            <div class="text-muted" style="margin-top:2px">玛修在玩家队伍中时为全队提供该加成；作为助战时不生效。</div>
          </div>
          <div v-if="Number(servantDetail.servantId) === 800100" class="field">
            <label>玛修的 Cost</label>
            <select
              :value="String(box[servantDetail.servantId].costOverride === null || box[servantDetail.servantId].costOverride === undefined ? 0 : box[servantDetail.servantId].costOverride)"
              @change="setCostOverride(servantDetail.servantId, $event.target.value)"
            >
              <option value="0">0（游戏里的默认值，不占 Cost 上限）</option>
              <option value="16">16（按 16 Cost 计算队伍）</option>
            </select>
            <div class="text-muted" style="margin-top:2px">改动会立刻用于算 Cost 上限与推荐结果，并跟账号一起保存。</div>
          </div>
          <div class="field" style="margin-top:8px;border-top:1px solid rgba(128,128,128,.25);padding-top:8px">
            <label>从活动导入该从者加成</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              <select v-model="servantDetailEventId" style="flex:1;min-width:200px">
                <option value="">请选择活动</option>
                <option v-for="ev in servantDetailEvents()" :key="ev.eventId" :value="ev.eventId">
                  {{ servantEventOptionLabel(ev, servantDetail.servantId) }}
                </option>
              </select>
              <button class="secondary" @click="applyServantDetailEventBonus">导入</button>
            </div>
            <div v-if="servantDetailEventId" class="text-muted" style="margin-top:4px">{{ servantDetailBonusText() }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 从者属性查看（可切换阶段/灵衣） -->
    <div v-if="servantAttr.visible" class="modal-mask" @click.self="closeServantAttr">
      <div class="modal-panel small">
        <div class="overlay-head">
          <h2>{{ servantAttr.servantId ? (servantMap[servantAttr.servantId] ? servantMap[servantAttr.servantId].name : '') : '' }} 属性</h2>
          <button class="secondary" @click="closeServantAttr">✕</button>
        </div>
        <div class="field">
          <label>阶段 / 灵衣</label>
          <select v-model="servantAttr.stage" @change="loadServantAttrTraits">
            <option v-for="opt in servantAttrOptions()" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
        <div class="text-muted" style="margin-bottom:6px">服务器：{{ serverRegion === 'cn' ? '简中服' : '日服' }}</div>
        <div v-if="servantAttr.loading" class="empty">加载中...</div>
        <div v-else-if="!servantAttr.rows.length" class="empty">没有读取到属性</div>
        <div v-else class="trait-info">
          <div v-for="row in servantAttr.rows" :key="row.label" class="trait-chip">{{ traitLabel(row.label) }}</div>
        </div>
      </div>
    </div>

    <!-- 结果查看信息弹窗 -->
    <div v-if="resultInfo.visible" class="modal-mask" @click.self="closeResultInfo">
      <div class="modal-panel small">
        <div class="overlay-head">
          <h2>{{ resultInfo.title }}</h2>
          <button class="secondary" @click="closeResultInfo">✕</button>
        </div>
        <div class="text-muted" style="margin:4px 0 8px">{{ resultInfo.subtitle }}</div>
        <div v-if="resultInfo.mode === 'servant'" class="trait-info">
          <div class="text-muted" style="margin-bottom:6px">属性列表（红边 = 命中当前队伍特性礼装条件）</div>
          <div v-if="!resultInfo.rows.length" class="empty">没有读取到属性</div>
          <div v-for="row in resultInfo.rows" :key="row.label" class="trait-chip" :class="{ active: row.active }">{{ traitLabel(row.label) }}</div>
        </div>
        <div v-else class="craft-info">
          <div v-for="row in resultInfo.rows" :key="row.label" class="info-row">
            <div class="info-label">{{ row.label }}</div>
            <div class="info-value">{{ row.value }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 账号管理（多账号：每个账号独立 Box + 排除列表） -->
    <div v-if="accountModalVisible" class="modal-mask" @click.self="accountModalVisible = false">
      <div class="modal-panel small account-modal">
        <div class="overlay-head">
          <h2>账号管理</h2>
          <button class="secondary" @click="accountModalVisible = false">✕</button>
        </div>
        <div class="text-muted" style="margin:2px 0 10px">
          一个账号 = 一套「用于计算的 Box + 排除列表」。切换账号后结果需要重新计算；
          固定队伍预设与自定义礼装为所有账号共享。
        </div>

        <div v-if="accountError" class="panel error" style="margin-bottom:8px">{{ accountError }}</div>

        <div class="account-list">
          <div
            v-for="a in accounts"
            :key="a.id"
            class="account-row"
            :class="{ active: a.id === activeAccountId }"
          >
            <div class="account-row-main">
              <template v-if="accountEditingId === a.id">
                <input v-model="accountEditingName" @keyup.enter="renameAccount(a)" @keyup.esc="cancelRenameAccount" />
              </template>
              <template v-else>
                <div class="account-row-name">
                  {{ a.name }}
                  <span v-if="a.id === activeAccountId" class="account-badge">当前</span>
                </div>
              </template>
              <div class="text-muted">{{ a.servantCount }} 名从者 · 排除 {{ a.exclusionCount }} 项</div>
            </div>
            <div class="account-row-actions">
              <template v-if="accountEditingId === a.id">
                <button class="secondary" @click="renameAccount(a)">保存</button>
                <button class="secondary" @click="cancelRenameAccount">取消</button>
              </template>
              <template v-else>
                <button v-if="a.id !== activeAccountId" class="secondary" @click="switchAccount(a.id)">切换</button>
                <button class="secondary" @click="startRenameAccount(a)">重命名</button>
              </template>
              <button class="secondary" @click="duplicateAccount(a)" title="复制该账号的 Box 与排除列表">复制</button>
              <button class="secondary" :disabled="accounts.length <= 1" @click="removeAccount(a)">删除</button>
            </div>
          </div>
        </div>

        <div class="account-create">
          <div class="field">
            <label>新建账号</label>
            <input v-model="newAccountName" placeholder="账号名称（留空自动命名）" @keyup.enter="createAccount" />
          </div>
          <label class="settings-row">
            <input type="checkbox" v-model="newAccountCopyFromCurrent" />
            <span>复制当前账号「{{ activeAccountName() }}」的 Box 与排除列表</span>
          </label>
          <button :disabled="accountBusy" @click="createAccount">＋ 新建账号</button>
        </div>
      </div>
    </div>

    <!-- 设置（PC：左上角「设置 ▾」按分区打开；安卓：工具栏「设置」打开全部分区） -->
    <div v-if="settingsVisible" class="modal-mask" @click.self="closeSettings">
      <div class="modal-panel small">
        <div class="overlay-head">
          <h2>{{ settingsSection === 'calc' ? '计算设置' : (settingsSection === 'display' ? '结果显示设置' : (settingsSection === 'diag' ? '诊断日志' : '设置')) }}</h2>
          <button class="secondary" @click="closeSettings">✕</button>
        </div>
        <div v-if="settingsSection === 'all'" class="settings-group-title">计算设置（影响怎么算）</div>
        <div v-if="settingsSection === 'all' || settingsSection === 'calc'" class="settings-list">
          <label class="settings-row">
            <span>结果完整度</span>
            <select v-model="resultSettings.searchOrder" :disabled="superOn" @change="persistResultSettings">
              <option value="craft">更全（默认）</option>
              <option value="servant">更快</option>
            </select>
          </label>
          <div class="text-muted" style="margin:-4px 0 4px">
            默认的「更全」会多跑一趟"按礼装批次挑人"的搜索：专门捞那种"几个人一起吃同一批礼装"的队伍
            —— 按单人评分排不进候选池、很容易被漏掉。它不会改变第 1 名，只是让后面的推荐更完整；
            代价是大约多花 15% 时间，嫌慢可以切「更快」。
          </div>
          <label class="settings-row" title="打开后所有人都按「还能继续涨」算（自身收益不再记 0），用来估算梦火喂给谁最划算；牵绊 Lv.15 以上给全队的 25% 照常计算，不受影响">
            <input type="checkbox" v-model="resultSettings.ignoreMaxBond" @change="persistResultSettings" />
            <span>把 Box 里全部从者视为「非满绊」</span>
          </label>
        </div>
        <div v-if="settingsSection === 'all'" class="settings-group-title">结果显示设置（只影响显示）</div>
        <div v-if="settingsSection === 'all' || settingsSection === 'display'" class="settings-list">
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.autoExpandFirst" @change="persistResultSettings" />
            <span>计算完成后自动展开第 1 个方案详情</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showSearchStats" @change="persistResultSettings" />
            <span>在结果区显示本次搜索统计（档位/耗时/处理组合数）</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showBonusFormula" @change="persistResultSettings" />
            <span>在详情里显示成员加成计算式</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showCostBreakdown" @change="persistResultSettings" />
            <span>在详情里显示成员 Cost 明细</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showCraftTriggers" @change="persistResultSettings" />
            <span>显示特性礼装的触发条件</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showCraftHits" @change="persistResultSettings" />
            <span>显示特性礼装的命中成员</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showDataVersion" @change="persistResultSettings" />
            <span>显示客户端版本 / 数据更新时间 / 数据区</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.showResultBondBadge" @change="persistResultSettings" />
            <span>在方案从者头像角标显示牵绊等级</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.hideEmptyCraftSlots" @change="persistResultSettings" />
            <span>隐藏空礼装槽</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.hideSupport" @change="persistResultSettings" />
            <span>隐藏助战位</span>
          </label>
          <label class="settings-row">
            <input type="checkbox" v-model="resultSettings.compareMode" @change="persistResultSettings" />
            <span>开启方案对比模式（结果卡出现勾选框）</span>
          </label>
          <label class="settings-row">
            <span>每页显示数量</span>
            <select v-model.number="resultSettings.pageSize" @change="persistResultSettings">
              <option :value="20">20 条</option>
              <option :value="50">50 条</option>
              <option :value="100">100 条</option>
            </select>
          </label>
        </div>
        <div v-if="diagLogAvailable() && (settingsSection === 'all' || settingsSection === 'diag')" style="margin-top:16px;border-top:1px solid rgba(255,255,255,.12);padding-top:12px">
          <h4 style="margin:0 0 8px">诊断日志</h4>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button class="secondary" @click="loadDiagnosticLog">读取</button>
            <button class="secondary" @click="copyDiagnosticLog" :disabled="!diagLogText">复制全部</button>
            <button class="secondary" @click="clearDiagnosticLog" :disabled="!diagLogText">清空</button>
            <span style="opacity:.75;font-size:12px">{{ diagLogNote || (diagLogLines ? '共 ' + diagLogLines + ' 行（只在本机，不会上传）' : (diagLogLoaded ? '日志是空的（暂时没有记录）' : '程序出错时这里会有记录')) }}</span>
          </div>
          <pre v-if="diagLogText" style="max-height:200px;overflow:auto;white-space:pre-wrap;font-size:12px;background:rgba(0,0,0,.28);padding:8px;border-radius:6px;margin:10px 0 0">{{ diagLogText }}</pre>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px">
          <button class="primary" @click="closeSettings">完成</button>
        </div>
      </div>
    </div>

    <!-- 使用说明（应用内阅读：左侧目录 + 右侧正文；内容来自 使用说明.txt） -->
    <div v-if="manualVisible" class="modal-mask" @click.self="closeManual">
      <div class="modal-panel manual-panel">
        <button class="secondary manual-close" @click="closeManual" title="关闭">✕</button>
        <div class="manual-body">
          <nav class="manual-toc">
            <button
              v-for="(sec, i) in manualSections"
              :key="i"
              :class="{ active: manualActive === i }"
              @click="gotoManualSection(i)"
            >{{ sec.title }}</button>
          </nav>
          <div class="manual-content" ref="manualContent">
            <section v-for="(sec, i) in manualSections" :key="i" :data-sec="i">
              <h3>{{ sec.title }}</h3>
              <template v-for="(b, j) in sec.blocks" :key="j">
                <p v-if="b.kind === 'gap'" class="manual-gap"></p>
                <p
                  v-else
                  :class="b.kind === 'sub' ? 'manual-sub' : (b.kind === 'bullet' ? 'manual-li d' + b.depth : 'manual-p')"
                  v-html="manualInlineHtml(b.text)"
                ></p>
              </template>
            </section>
          </div>
        </div>
      </div>
    </div>

    <!-- 方案对比 -->
    <div v-if="compareVisible" class="modal-mask" @click.self="closeCompare">
      <div class="modal-panel compare-panel">
        <div class="overlay-head">
          <h2>方案对比（{{ compareResults.length }}）</h2>
          <button class="secondary" @click="closeCompare">✕</button>
        </div>
        <div class="compare-scroll">
          <table class="compare-table">
            <thead>
              <tr>
                <th>项目</th>
                <th v-for="r in compareResults" :key="r.rank">方案 #{{ r.rank }}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>总倍率</td>
                <td v-for="r in compareResults" :key="'mult-' + r.rank">x{{ Number(r.totalMultiplier).toFixed(3) }}</td>
              </tr>
              <tr>
                <td>预计牵绊</td>
                <td v-for="r in compareResults" :key="'bp-' + r.rank">{{ r.totalBondPoints ? formatBondNumber(r.totalBondPoints) : "—" }}</td>
              </tr>
              <tr>
                <td>Cost</td>
                <td v-for="r in compareResults" :key="'cost-' + r.rank">{{ resultCostUsed(r) }}/{{ costLimit }}</td>
              </tr>
              <tr>
                <td>队伍</td>
                <td v-for="r in compareResults" :key="'team-' + r.rank">
                  <div v-for="m in visibleResultTeam(r)" :key="m.position" class="compare-member">
                    <div class="compare-member-name">{{ positionLabel(m.position) }}：{{ m.isSupport ? '助战 ' : '' }}{{ resultMemberName(m) }}</div>
                    <div class="text-muted compare-member-craft">{{ memberCraftsText(m) }}</div>
                    <div v-if="!m.isSupport" class="text-muted">x{{ Number(m.bonusDetail?.totalMultiplier || 0).toFixed(3) }}</div>
                  </div>
                </td>
              </tr>
              <tr>
                <td>特性覆盖</td>
                <td v-for="r in compareResults" :key="'trait-' + r.rank">
                  <span v-if="r.traitCoverage && r.traitCoverage.length">{{ traitCoverageText(r) }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 悬停提示 -->
    <div v-if="hover.visible" class="hover-tip" :style="{ left: hover.x + 'px', top: hover.y + 'px' }">{{ hover.text }}</div>

    <!-- 右键菜单 -->
    <div v-if="contextMenu.visible" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
      <template v-if="contextMenu.target === 'box'">
        <div class="ctx-item" @click="ctxDetail">⚙️ 从者设置</div>
        <div class="ctx-item" @click="ctxServantAttr">🔍 从者属性</div>
      </template>
      <template v-else-if="contextMenu.target === 'overlay-servant'">
        <div class="ctx-item" @click="ctxOverlayServantDetail">⚙️ 从者设置</div>
        <div class="ctx-item" @click="ctxOverlayServantAttr">🔍 从者属性</div>
      </template>
      <template v-else-if="contextMenu.target === 'result-servant'">
        <div class="ctx-item" @click="ctxSimpleExclude">🚫 简易排除</div>
        <div class="ctx-item" @click="ctxResultInfo">ℹ️ 查看属性</div>
      </template>
      <template v-else-if="contextMenu.target === 'result-craft'">
        <div class="ctx-item" @click="ctxResultInfo">ℹ️ 查看信息</div>
      </template>
      <template v-else-if="contextMenu.target === 'verification-mode'">
        <div class="ctx-item" @click="setVerificationMode('repro')">
          {{ verificationMode === 'repro' ? '✅ ' : '' }}复现模式（默认，串较短）
        </div>
        <div class="ctx-item" @click="setVerificationMode('full')">
          {{ verificationMode === 'full' ? '✅ ' : '' }}完整模式（全量静态数据）
        </div>
      </template>
      <template v-else-if="contextMenu.target === 'feedback-mode'">
        <div class="ctx-item" @click="setFeedbackMode('brief')">
          {{ resultSettings.feedbackMode === 'brief' ? '✅ ' : '' }}简短模式（只含选中方案）
        </div>
        <div class="ctx-item" @click="setFeedbackMode('full')">
          {{ resultSettings.feedbackMode === 'full' ? '✅ ' : '' }}完整模式（含 Box、礼装池、固定配置）
        </div>
      </template>
      <template v-else>
        <div v-if="contextMenu.target === 'servant' && contextMenu.slotIndex !== null && slots[contextMenu.slotIndex].servantId !== null" class="ctx-item" @click="ctxDetail">⚙️ 从者设置</div>
        <div v-if="contextMenu.target === 'servant' && contextMenu.slotIndex !== null && slots[contextMenu.slotIndex].servantId !== null" class="ctx-item" @click="ctxServantAttr">🔍 从者属性</div>
        <div v-if="mode === 'crown' && contextMenu.target === 'servant' && contextMenu.slotIndex !== null" class="ctx-item" @click="ctxCrown">
          {{ slots[contextMenu.slotIndex].isCrown ? '✴️ 取消冠位从者位' : '✴️ 设为冠位从者位' }}
        </div>
        <div class="ctx-item" @click="ctxSupport">
          {{ contextMenu.slotIndex !== null && slots[contextMenu.slotIndex].isSupport ? '取消助战' : '设为助战' }}
        </div>
        <div class="ctx-item" @click="ctxReplace">✏️ 更换{{ contextMenu.target === 'craft' && contextMenu.craftIndex === 1 ? '第二礼装' : '' }}</div>
        <div class="ctx-item" @click="ctxClear">🗑️ 清空{{ contextMenu.target === 'servant' ? '从者+礼装' : (contextMenu.craftIndex === 1 ? '第二礼装' : '礼装') }}</div>
      </template>
    </div>
  </div>
  `,
};

const ProgressBar = {
  props: ["visible", "message"],
  template: `
    <div v-if="visible" class="progress-wrap">
      <div class="progress-bar"><div></div></div>
      <div class="text-muted" style="margin-top:4px">{{ message || '计算中...' }}</div>
    </div>
  `,
};

App.components = { ProgressBar };
App.computed.stageOptions = () => STAGES;
App.computed.classOptions = () => CLASSES;

createApp(App).mount("#app");
