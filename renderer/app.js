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
    isSupport: i === 2,
    stage: null,
  }));
}

const App = {
  data() {
    return {
      loading: true,
      error: "",
      info: null,
      costumeNames: {},
      missingAvatars: [],
      avatarBroken: [],
      servants: [],
      bondCrafts: [],
      otherCrafts: [],
      allCrafts: [],
      box: {}, // id -> {checked, stage, maxBond, switch1, switch2, personalBonus}
      boxFilter: { keyword: "", class: "all", rarity: "all", owned: "all", maxBond: "all" },
      batchBonus: 0,
      slots: makeSlots(),
      costLimit: 116,
      strategy: "total_max",
      qualityMode: "balanced",
      targetServantId: null,
      targetServantKeyword: "",
      overlay: { visible: false, slotIndex: null, target: "servant", keyword: "", classFilter: "all", rarityFilter: "all", ownedOnly: true, craftType: "bond" },
      boxModalVisible: false,
      exclusionModalVisible: false,
      exclusionTab: "servant",
      exclusionKeyword: "",
      exclusionClass: "all",
      exclusionRarity: "all",
      exclusionMaxBond: "all",
      exclusionCraftKeyword: "",
      excludedServants: [],
      excludedCrafts: [],
      batchModalVisible: false,
      batchSelectedServants: [],
      eventBondBonuses: [],
      selectedEventId: null,
      batchImportMessage: "",
      teamModalVisible: false,
      contextMenu: { visible: false, x: 0, y: 0, slotIndex: null, target: null, result: null, member: null },
      hover: { visible: false, x: 0, y: 0, text: "" },
      servantDetail: { visible: false, servantId: null, slotIndex: null },
      servantDetailEventId: "",
      presets: [],
      presetModalVisible: false,
      calculating: false,
      progress: "",
      results: [],
      totalCandidates: 0,
      expandedResult: null,
      simpleExcludedServants: [],
      currentPage: 1,
      pageSize: 50,
      resultInfo: { visible: false, mode: "", title: "", subtitle: "", rows: [] },
      updateModalVisible: false,
      updateRunning: false,
      updateItems: [],
      updateResult: null,
      updateError: "",
    };
  },
  computed: {
    ownedServants() {
      return this.servants.filter((s) => this.box[s.id] && this.box[s.id].checked);
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
          !this.isGenericUniversal5Actual(c)
      );
      return [this.universal5Craft, ...actual];
    },
    otherCraftOptions() {
      return [
        { id: 0, name: "没有（无礼装）", rarity: 0, cost: 0, detail: "不装备礼装" },
        { id: -1, name: "其他礼装(1★)", rarity: 1, cost: 1, detail: "无牵绊加成，仅占 Cost 1" },
        { id: -2, name: "其他礼装(2★)", rarity: 2, cost: 3, detail: "无牵绊加成，仅占 Cost 3" },
        { id: -3, name: "其他礼装(3★)", rarity: 3, cost: 5, detail: "无牵绊加成，仅占 Cost 5" },
        { id: -4, name: "其他礼装(4★)", rarity: 4, cost: 9, detail: "无牵绊加成，仅占 Cost 9" },
        { id: -5, name: "其他礼装(5★)", rarity: 5, cost: 12, detail: "无牵绊加成，仅占 Cost 12" },
      ];
    },
    avatarMissingSet() {
      return new Set([...this.missingAvatars, ...this.avatarBroken].map(String));
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
        const s = this.servantMap[slot.servantId];
        if (s) total += s.cost || 0;
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
    overlayItems() {
      if (this.overlay.target === "servant") {
        const kw = this.overlay.keyword.toLowerCase();
        const isSupportSlot = this.overlay.slotIndex !== null && this.slots[this.overlay.slotIndex] && this.slots[this.overlay.slotIndex].isSupport;
        // 助战从者可选择所有已收录角色（不限于自己 Box）
        const source = isSupportSlot ? this.servants : this.ownedServants;
        return source
          .filter((s) => {
            if (kw && !s.name.toLowerCase().includes(kw)) return false;
            if (!this.matchesClassFilter(s.class, this.overlay.classFilter)) return false;
            if (this.overlay.rarityFilter !== "all" && Number(s.rarity) !== Number(this.overlay.rarityFilter)) return false;
            return true;
          })
          .slice()
          .sort((a, b) => b.collectionNo - a.collectionNo);
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
    filteredExclusionServants() {
      const kw = this.exclusionKeyword.trim().toLowerCase();
      return this.ownedServants
        .filter((s) => {
          if (kw && !s.name.toLowerCase().includes(kw)) return false;
          if (!this.matchesClassFilter(s.class, this.exclusionClass)) return false;
          if (this.exclusionRarity !== "all" && Number(s.rarity) !== Number(this.exclusionRarity)) return false;
          const b = this.box[s.id];
          if (this.exclusionMaxBond === "max" && !(b && b.maxBond)) return false;
          if (this.exclusionMaxBond === "notMax" && b && b.maxBond) return false;
          return true;
        })
        .slice()
        .sort((a, b) => b.collectionNo - a.collectionNo);
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
      const ex = this.simpleExcludedSet;
      return this.results.filter((r) => !(r.team || []).some((m) => ex.has(Number(m.servantId))));
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
    try {
      const [info, servants, bondCrafts, allCrafts, userBox, presets, costumeNames, exclusions] = await Promise.all([
        window.fgo.getAppInfo(),
        window.fgo.listServants(),
        window.fgo.listBondCrafts(),
        window.fgo.listAllCrafts(),
        window.fgo.getUserBox(),
        window.fgo.listUserTeams(),
        window.fgo.getCostumeNames(),
        window.fgo.getExclusions(),
      ]);
      this.info = info;
      this.costumeNames = costumeNames || {};
      this.excludedServants = (exclusions && exclusions.servants) || [];
      this.excludedCrafts = (exclusions && exclusions.crafts) || [];
      this.servants = servants;
      this.bondCrafts = bondCrafts;
      this.allCrafts = allCrafts;
      this.presets = presets || [];
      this.otherCrafts = (allCrafts || []).filter((c) => c.craftType === "other");

      const saved = {};
      (userBox || []).forEach((e) => {
        saved[e.servantId] = {
          checked: true,
          stage: e.stage || "fourth",
          maxBond: !!e.isMaxBond,
          switch1: e.bondSwitch1 !== 0,
          switch2: !!e.bondSwitch2,
          personalBonus: e.personalBonus || 0,
          auraBonus: e.auraBonus || 0,
        };
      });
      this.servants.forEach((s) => {
        if (!saved[s.id]) {
          saved[s.id] = { checked: false, stage: "fourth", maxBond: false, switch1: false, switch2: false, personalBonus: 0, auraBonus: 0 };
        }
      });
      this.box = saved;

      window.fgo.onEngineProgress((data) => {
        const msg = data.message || "";
        if (this.updateRunning) {
          this.handleUpdateProgress(msg);
        } else {
          this.progress = msg;
        }
      });
      window.fgo.onMenuAction((data) => {
        if (data && data.channel === "menu:update-data") this.runUpdate(false);
        if (data && data.channel === "menu:update-data-force") this.runUpdate(true);
      });
    } catch (e) {
      this.error = e.message || String(e);
    } finally {
      this.loading = false;
    }
  },
  methods: {
    // ---------- 工具 ----------
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
      }
      return this.craftMap[craftId] || null;
    },
    slotCraft(slot) {
      return this.craftById(slot.craftId);
    },
    craftEffect(c) {
      if (!c) return "";
      return c.detail || c.name || "";
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
        c.bonusType === "universal" &&
        Math.abs((c.bonusValue || 0) - 0.05) < 1e-9 &&
        !(Number(c.supportBonus || 0) > 0)
      );
    },
    slotPosition(i) { return POSITION_KEYS[i]; },
    matchesClassFilter(servantClass, filterValue) {
      if (!filterValue || filterValue === "all") return true;
      const c = String(servantClass || "").toLowerCase();
      const f = String(filterValue).toLowerCase();
      if (f === "beast") return c.includes("beast");
      return c === f;
    },
    avatarPath(servantId) {
      return `./assets/servantface/${servantId}.png`;
    },
    markAvatarBroken(id) {
      const key = String(id);
      if (!this.avatarBroken.includes(key)) this.avatarBroken.push(key);
    },
    hasAvatar(servantId) {
      return this.avatarSet && this.avatarSet.has(String(servantId));
    },
    showHover(e, servant) {
      if (!servant) return;
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
    async persistBox() {
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
        }));
      try { await window.fgo.saveUserBox(plainClone(entries)); } catch (_) { /* ignore */ }
    },
    toggleOwned(id) {
      const b = this.box[id];
      b.checked = !b.checked;
      if (!b.checked) {
        b.maxBond = false;
        b.switch1 = false;
        b.switch2 = false;
        // 如果队伍里已使用该从者，自动移除
        for (const slot of this.slots) {
          if (slot.servantId === id) { slot.servantId = null; slot.craftId = null; }
        }
      }
      this.persistBox();
    },
    toggleMaxBond(id) {
      const b = this.box[id];
      b.maxBond = !b.maxBond;
      if (!b.maxBond) { b.switch1 = false; b.switch2 = false; }
      else { b.switch1 = true; b.switch2 = false; }
      this.persistBox();
    },
    toggleSwitch1(id) {
      const b = this.box[id];
      b.switch1 = !b.switch1;
      if (!b.switch1) b.switch2 = false;
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
    toggleBatchSelect(id) {
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
        this.box[s.id] = { checked: false, stage: "fourth", maxBond: false, switch1: false, switch2: false, personalBonus: 0, auraBonus: 0 };
      });
      this.slots = makeSlots();
      this.persistBox();
    },
    async reloadBoxFromServer() {
      const userBox = await window.fgo.getUserBox();
      const saved = {};
      (userBox || []).forEach((e) => {
        saved[e.servantId] = {
          checked: true,
          stage: e.stage || "fourth",
          maxBond: !!e.isMaxBond,
          switch1: e.bondSwitch1 !== 0,
          switch2: !!e.bondSwitch2,
          personalBonus: e.personalBonus || 0,
          auraBonus: e.auraBonus || 0,
        };
      });
      this.servants.forEach((s) => {
        if (!saved[s.id]) {
          saved[s.id] = { checked: false, stage: "fourth", maxBond: false, switch1: false, switch2: false, personalBonus: 0, auraBonus: 0 };
        }
      });
      this.box = saved;
    },
    async reloadAllData() {
      const [servants, bondCrafts, allCrafts, costumeNames, exclusions, eventBonuses] = await Promise.all([
        window.fgo.listServants(),
        window.fgo.listBondCrafts(),
        window.fgo.listAllCrafts(),
        window.fgo.getCostumeNames(),
        window.fgo.getExclusions(),
        window.fgo.getEventBondBonuses(),
      ]);
      this.servants = servants || [];
      this.bondCrafts = bondCrafts || [];
      this.allCrafts = allCrafts || [];
      this.otherCrafts = (allCrafts || []).filter((c) => c.craftType === "other");
      this.costumeNames = costumeNames || {};
      this.excludedServants = (exclusions && exclusions.servants) || [];
      this.excludedCrafts = (exclusions && exclusions.crafts) || [];
      this.eventBondBonuses = eventBonuses || [];
      await this.reloadBoxFromServer();
    },
    isExcludedServant(id) {
      return this.excludedServantSet.has(Number(id));
    },
    isExcludedCraft(id) {
      return this.excludedCraftSet.has(Number(id));
    },
    async persistExclusions() {
      await window.fgo.saveExclusions(plainClone({
        servants: this.excludedServants,
        crafts: this.excludedCrafts,
      }));
    },
    async toggleExcludeServant(id) {
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
      if (input) input.click();
    },
    async onCaptureFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const result = await window.fgo.importCapture(text);
        alert(`导入成功：持有从者 ${result.servants} 位，满绊 ${result.maxBond} 位`);
        await this.reloadBoxFromServer();
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
    openOverlay(slotIndex, target) {
      this.overlay = {
        visible: true,
        slotIndex,
        target,
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
      return Number(craftId) <= 0;
    },
    isSupportOnlyCraft(craftId) {
      const c = this.craftById(craftId);
      return !!(c && Number(c.supportBonus || 0) > 0);
    },
    chooseCraft(slotIndex, craftId) {
      const target = this.slots[slotIndex];
      if (!target.isSupport && this.isSupportOnlyCraft(craftId)) {
        alert("迦勒底午茶时光等助战加成礼装只能放在助战位");
        return;
      }
      const existing = this.slots.findIndex((s, i) => i !== slotIndex && s.craftId === craftId);
      // 助战位可与任意位置重复；“通用5%”在玩家位之间也可重复。
      const allowDuplicate =
        (existing >= 0 && (target.isSupport || this.slots[existing].isSupport)) ||
        this.isRepeatableCraft(craftId);
      if (existing >= 0 && !allowDuplicate) {
        if (!confirm("该礼装已在其他槽位，是否移回当前槽位？")) return;
        this.slots[existing].craftId = null;
      }
      this.slots[slotIndex].craftId = craftId;
      this.closeOverlay();
    },
    clearSlotServant(i) {
      this.slots[i].servantId = null;
      this.slots[i].craftId = null;
      this.slots[i].isSupport = false;
      this.slots[i].stage = null;
    },
    clearSlotCraft(i) {
      this.slots[i].craftId = null;
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
    openContextMenu(e, slotIndex, target) {
      e.preventDefault();
      this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, slotIndex, target };
    },
    closeContextMenu() { this.contextMenu.visible = false; },
    ctxSupport() {
      const i = this.contextMenu.slotIndex;
      if (i !== null) this.toggleSupport(i);
      this.closeContextMenu();
    },
    ctxClear() {
      const { slotIndex, target } = this.contextMenu;
      if (slotIndex !== null) {
        if (target === "servant") this.clearSlotServant(slotIndex);
        else this.clearSlotCraft(slotIndex);
      }
      this.closeContextMenu();
    },
    openBoxContext(e, servant) {
      e.preventDefault();
      this.contextMenu = { visible: true, x: e.clientX, y: e.clientY, slotIndex: null, target: "box", servantId: servant.id };
    },
    ctxDetail() {
      const { slotIndex, servantId } = this.contextMenu;
      const sid = servantId !== undefined ? servantId : (slotIndex !== null ? this.slots[slotIndex].servantId : null);
      const detailSlotIndex = this.contextMenu.target === "servant" ? slotIndex : null;
      this.closeContextMenu();
      if (sid !== null) this.openServantDetail(sid, detailSlotIndex);
    },
    ctxReplace() {
      const { slotIndex, target } = this.contextMenu;
      this.closeContextMenu();
      if (slotIndex !== null) this.openOverlay(slotIndex, target);
    },
    openResultContext(e, result, member, kind) {
      e.preventDefault();
      this.contextMenu = {
        visible: true,
        x: e.clientX,
        y: e.clientY,
        slotIndex: null,
        target: kind === "craft" ? "result-craft" : "result-servant",
        result,
        member,
      };
    },
    ctxSimpleExclude() {
      const m = this.contextMenu.member;
      this.closeContextMenu();
      if (m) this.toggleSimpleExclude(m.servantId);
    },
    ctxResultInfo() {
      const { result, member, target } = this.contextMenu;
      this.closeContextMenu();
      if (result && member) this.openResultInfo(result, member, target === "result-craft" ? "craft" : "servant");
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
        const c = this.craftById(m.craftId);
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
      return active;
    },
    async openResultInfo(result, member, kind) {
      if (kind === "craft") {
        const c = this.craftById(member.craftId);
        if (!c) return;
        this.resultInfo = {
          visible: true,
          mode: "craft",
          title: c.name || "礼装",
          subtitle: `${c.rarity || 0}★ / Cost ${c.cost || 0}`,
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
        ? (this.costumeNames[String(member.stage.split("_")[1])] ? "灵衣：" + this.costumeNames[String(member.stage.split("_")[1])] : member.stage)
        : this.stageLabel(member.stage || "fourth");
      this.resultInfo = {
        visible: true,
        mode: "servant",
        title: sname,
        subtitle: `${stageLabel}（推荐方案 #${result.rank}）`,
        rows: [],
      };
      try {
        const traits = await window.fgo.getStageTraits(member.servantId, member.stage || "fourth");
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
      if (!confirm("此操作将清空所有格子、固定状态、助战状态，并恢复Cost上限与策略，是否继续？")) return;
      this.slots = makeSlots();
      this.costLimit = 116;
      this.strategy = "total_max";
      this.qualityMode = "balanced";
      this.targetServantId = null;
      this.targetServantKeyword = "";
      this.results = [];
    },
    randomFillFree() {
      const usedIds = new Set(this.slots.filter((s) => s.servantId !== null).map((s) => s.servantId));
      const usedCraftIds = new Set(this.slots.filter((s) => !s.isSupport && s.craftId !== null).map((s) => s.craftId));
      const candidates = this.ownedServants.filter((s) => !usedIds.has(s.id));
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].servantId === null && !this.slots[i].isSupport) {
          if (!candidates.length) break;
          const idx = Math.floor(Math.random() * candidates.length);
          const s = candidates.splice(idx, 1)[0];
          this.slots[i].servantId = s.id;
          const availableCrafts = this.meaningfulBondCrafts.filter(
            (c) =>
              !this.isSupportOnlyCraft(c.id) &&
              (this.isRepeatableCraft(c.id) || !usedCraftIds.has(c.id))
          );
          const c = availableCrafts.length ? availableCrafts[Math.floor(Math.random() * availableCrafts.length)] : null;
          this.slots[i].craftId = c ? c.id : null;
          if (c && !this.isRepeatableCraft(c.id)) usedCraftIds.add(c.id);
        }
      }
    },
    async saveTeam() {
      const name = prompt("预设名称", `队伍 ${new Date().toLocaleString()}`);
      if (!name) return;
      const fixedServants = [];
      const fixedCrafts = [];
      this.slots.forEach((slot, i) => {
        if (slot.isSupport) return;
        if (slot.servantId !== null) {
          const fixed = { position: this.slotPosition(i), servantId: slot.servantId };
          if (slot.stage) fixed.stage = slot.stage;
          fixedServants.push(fixed);
        }
        if (slot.craftId !== null) {
          const craft = this.craftById(slot.craftId);
          fixedCrafts.push({ position: this.slotPosition(i), craftId: slot.craftId, type: craft && craft.craftType === "bond" ? "bond" : "other" });
        }
      });
      const supportSlot = this.slots.find((s) => s.isSupport);
      const team = {
        name,
        fixedServants,
        fixedCrafts,
        supportId: supportSlot && supportSlot.servantId !== null ? supportSlot.servantId : null,
        supportCraftId: supportSlot && supportSlot.craftId !== null ? supportSlot.craftId : null,
        costLimit: this.costLimit,
        strategy: this.strategy,
        qualityMode: this.qualityMode,
      };
      await window.fgo.saveUserTeam(plainClone(team));
      this.presets = await window.fgo.listUserTeams();
      alert("队伍已保存");
    },
    async loadPreset(preset) {
      const fixedServants = preset.fixedServants || [];
      const fixedCrafts = preset.fixedCrafts || [];
      const support = { servantId: preset.supportId, craftId: preset.supportCraftId };
      const fresh = makeSlots();
      fixedServants.forEach((f) => {
        const idx = POSITION_KEYS.indexOf(f.position);
        if (idx >= 0) {
          fresh[idx].servantId = f.servantId;
          fresh[idx].stage = f.stage || null;
        }
      });
      fixedCrafts.forEach((f) => {
        const idx = POSITION_KEYS.indexOf(f.position);
        if (idx >= 0) fresh[idx].craftId = f.craftId;
      });
      if (support.servantId || (support.craftId !== null && support.craftId !== undefined)) {
        // 放到空闲位；如果已有相同从者占用则移动
        const used = support.servantId ? fresh.findIndex((s) => s.servantId === support.servantId) : -1;
        let idx = used >= 0 ? used : fresh.findIndex((s) => s.servantId === null);
        if (idx < 0) idx = 0;
        if (support.servantId) fresh[idx].servantId = support.servantId;
        if (support.craftId !== null && support.craftId !== undefined) fresh[idx].craftId = support.craftId;
        fresh[idx].isSupport = true;
      }
      this.slots = fresh;
      this.costLimit = preset.costLimit || 116;
      this.strategy = preset.strategy || "total_max";
      this.qualityMode = preset.qualityMode || "balanced";
      this.presetModalVisible = false;
    },

    // ---------- 计算 ----------
    buildPayload() {
      const box = this.ownedServants.map((s) => {
        const b = this.box[s.id];
        return {
          id: s.id,
          stage: b.stage,
          maxBond: b.maxBond,
          bondSwitch1: b.switch1,
          bondSwitch2: b.switch2,
          personalBonus: Number(b.personalBonus || 0) / 100,
          auraBonus: Number(b.auraBonus || 0) / 100,
        };
      });
      const fixedServants = [];
      const fixedCrafts = [];
      let support = {};
      this.slots.forEach((slot, i) => {
        const pos = this.slotPosition(i);
        if (slot.isSupport) {
          support = {
            position: pos,
            servantId: slot.servantId || null,
            craftId: slot.craftId === null ? null : slot.craftId,
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
          fixedCrafts.push({ position: pos, craftId: slot.craftId, type: craft && craft.craftType === "bond" ? "bond" : "other" });
        }
      });
      return {
        box,
        fixedServants,
        fixedCrafts,
        support,
        costLimit: Number(this.costLimit),
        strategy: this.strategy,
        targetServantId: this.strategy === "target_max" ? this.targetServantId : null,
        excludedServantIds: this.excludedServants,
        excludedCraftIds: this.excludedCrafts,
        activityBonus: 0,
        teaBonus: 1,
        topN: 1000,
        timeoutMs: { fast: 10000, balanced: 25000, high: 60000 }[this.qualityMode] || 10000,
      };
    },
    async calculate() {
      this.error = "";
      this.results = [];
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
        this.results = result.top20 || [];
        this.totalCandidates = result.totalCandidates || this.results.length;
        this.currentPage = 1;
        setTimeout(() => {
          document.querySelector(".results-section")?.scrollIntoView({ behavior: "smooth" });
        }, 50);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.calculating = false;
      }
    },
    initUpdateItems() {
      return [
        { key: "check", label: "检查更新", status: "pending", detail: "", percent: null },
        { key: "servant_download", label: "下载从者数据", status: "pending", detail: "", percent: null },
        { key: "servant_write", label: "写入从者/特性", status: "pending", detail: "", percent: null },
        { key: "equip_download", label: "下载礼装数据", status: "pending", detail: "", percent: null },
        { key: "equip_write", label: "写入礼装数据", status: "pending", detail: "", percent: null },
        { key: "costume", label: "更新灵衣名称", status: "pending", detail: "", percent: null },
        { key: "done", label: "完成", status: "pending", detail: "", percent: null },
      ];
    },
    setUpdateItem(key, status, detail, percent) {
      const item = this.updateItems.find((i) => i.key === key);
      if (!item) return;
      item.status = status;
      if (detail !== undefined) item.detail = detail;
      if (percent !== undefined) item.percent = percent;
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
        if (key) this.setUpdateItem(key, "done");
      };

      if (msg.includes("正在检查数据更新")) {
        this.setUpdateItem("check", "running", "正在连接数据源...");
        return;
      }
      if (msg.includes("正在下载从者数据")) {
        markActiveDone();
        this.setUpdateItem("servant_download", "running", "开始下载...", 0);
        return;
      }
      if (msg.includes("正在写入从者与特性数据")) {
        markActiveDone();
        this.setUpdateItem("servant_write", "running", "正在写入本地数据库...");
        return;
      }
      if (msg.includes("正在下载礼装数据")) {
        markActiveDone();
        this.setUpdateItem("equip_download", "running", "开始下载...", 0);
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
      if (msg.includes("数据更新完成") || msg.includes("数据已是最新版本")) {
        markActiveDone();
        this.setUpdateItem("done", "done", msg.includes("最新") ? "无需更新" : "更新完成");
        return;
      }

      // 下载百分比行
      let m = msg.match(/nice_servant:\s*(\d+)%/);
      if (m) {
        this.setUpdateItem("servant_download", "running", `下载从者数据 ${m[1]}%`, Number(m[1]));
        return;
      }
      if (msg.includes("nice_servant: done")) {
        this.setUpdateItem("servant_download", "done", "下载完成");
        return;
      }
      m = msg.match(/nice_equip:\s*(\d+)%/);
      if (m) {
        this.setUpdateItem("equip_download", "running", `下载礼装数据 ${m[1]}%`, Number(m[1]));
        return;
      }
      if (msg.includes("nice_equip: done")) {
        this.setUpdateItem("equip_download", "done", "下载完成");
        return;
      }
    },
    openUpdateModal() {
      this.updateModalVisible = true;
      if (!this.updateRunning && !this.updateItems.length) {
        this.updateItems = this.initUpdateItems();
      }
    },
    closeUpdateModal() {
      if (!this.updateRunning) this.updateModalVisible = false;
    },
    async runUpdate(force) {
      this.updateModalVisible = true;
      this.updateRunning = true;
      this.updateResult = null;
      this.updateError = "";
      this.updateItems = this.initUpdateItems();
      this.setUpdateItem("check", "running", "正在检查远程数据...");
      try {
        const r = await window.fgo.updateData(force);
        this.updateRunning = false;
        this.updateResult = r;
        if (r && r.status === "no_change") {
          this.setUpdateItem("check", "done", "本地已是最新版本");
          this.setUpdateItem("done", "done", "无需更新");
        } else {
          const active = this.updateItems.find((i) => i.status === "running");
          if (active) this.setUpdateItem(active.key, "done");
          this.setUpdateItem("done", "done", "更新完成");
          try {
            await this.reloadAllData();
            this.updateResult = Object.assign({}, r, { uiReloaded: true });
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
    exportJson(result) {
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `FGO方案#${result.rank}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
  },
  template: `
  <div class="board-app" @click="closeContextMenu">
    <!-- 顶部工具栏 -->
    <div class="topbar">
      <h1>FGO牵绊推荐器</h1>
      <div>
        <button class="secondary" @click.stop="boxModalVisible = true">Box管理</button>
        <button class="secondary" @click.stop="exclusionModalVisible = true">排除管理</button>
        <button class="secondary" @click.stop="openUpdateModal">更新数据</button>
      </div>
    </div>

    <div v-if="error" class="panel error">{{ error }}</div>
    <div v-if="loading" class="empty">加载中...</div>
    <template v-else>
      <!-- 6 槽位主区域 -->
      <div class="board-area">
        <div v-for="(slot, i) in slots" :key="i" class="slot-col" :class="{ 'slot-support': slot.isSupport }">
          <div
            class="cell cell-servant"
            :class="{ empty: !slot.servantId, support: slot.isSupport }"
            @click="slot.servantId ? openOverlay(i, 'servant') : openOverlay(i, 'servant')"
            @contextmenu="openContextMenu($event, i, 'servant')"
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
              <span class="placeholder">{{ slot.isSupport ? '选择助战从者' : '点击选择从者' }}</span>
            </template>
          </div>

          <div
            class="cell cell-craft"
            :class="{ empty: slot.craftId === null || slot.craftId === undefined }"
            @click="openOverlay(i, 'craft')"
            @contextmenu="openContextMenu($event, i, 'craft')"
          >
            <template v-if="slot.craftId !== null && slot.craftId !== undefined">
              <img v-if="hasCraftImage(slotCraft(slot))" :src="craftImagePath(slotCraft(slot))" class="cell-craft-img" alt="" />
              <div class="cell-name small">{{ slotCraft(slot).name }}</div>
              <div class="cell-meta">{{ slotCraft(slot).rarity }}★ / Cost {{ slotCraft(slot).cost }}</div>
              <div class="cell-effect">{{ craftEffect(slotCraft(slot)) }}</div>
            </template>
            <template v-else>
              <span class="placeholder">{{ slot.isSupport ? '选择助战礼装' : '点击选择礼装' }}</span>
            </template>
          </div>
        </div>
      </div>

      <!-- 队伍配置（一级页面） -->
      <div class="team-config panel">
        <div class="team-config-title">队伍配置</div>
        <div class="team-config-fields">
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
          <div class="field">
            <label>计算质量 / 等待时间</label>
            <select v-model="qualityMode">
              <option value="fast">快速（约 3~10 秒）</option>
              <option value="balanced">平衡（约 10~25 秒）</option>
              <option value="high">高质量（约 30~60 秒）</option>
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

      <!-- 底部信息/操作 -->
      <div class="bottom-bar panel">
        <div class="text-muted">
          Cost {{ costUsed }}/{{ costLimit }} | 固定 {{ fixedCount }} | 自由 {{ freeCount }} | 助战 {{ supportCount }}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
          <button class="secondary" @click="resetTeam">清空队伍</button>
          <button class="secondary" @click="randomFillFree">随机填充自由位</button>
          <button class="secondary" @click="saveTeam">保存队伍</button>
          <button class="secondary" @click="presetModalVisible = true; presets = presets">加载预设</button>
          <button class="primary main-action" :disabled="calculating" @click="calculate">🚀 开始计算</button>
        </div>
        <progress-bar :visible="calculating" :message="progress"></progress-bar>
      </div>

      <!-- 结果区：一级页面滚轮下滑查看 -->
      <div class="results-section panel">
        <div class="results-head">
          <h2>推荐结果（共 {{ totalCandidates }} 个，当前显示 {{ filteredResults.length }} 个）</h2>
          <div v-if="simpleExcludedServants.length" class="simple-exclusions">
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
        <div v-if="!results.length" class="empty">点击“开始计算”后结果会显示在这里</div>
        <div v-else-if="!filteredResults.length" class="empty">当前简易排除后没有符合条件的队伍</div>
        <div v-for="r in pagedResults" :key="r.rank" class="result-card">
          <div class="head">
            <strong>方案 #{{ r.rank }} ⭐ {{ r.totalMultiplier.toFixed(3) }}x</strong>
            <span class="text-muted">Cost {{ r.costUsed }}/{{ costLimit }}</span>
            <span style="flex:1"></span>
            <button class="secondary" @click="expandedResult = (expandedResult === r ? null : r)">详情</button>
            <button class="secondary" @click="exportJson(r)">导出JSON</button>
          </div>
          <div class="result-board">
            <div v-for="m in r.team" :key="m.position" class="result-col">
              <div class="mini-cell mini-servant" :class="{ support: m.isSupport, fixed: m.isFixed }" @contextmenu="openResultContext($event, r, m, 'servant')">
                <img v-if="!avatarMissingSet.has(String(m.servantId))" :src="avatarPath(m.servantId)" class="mini-avatar" alt="" @error="markAvatarBroken(m.servantId)" />
                <div v-else class="mini-avatar fallback">{{ (m.name || '?').charAt(0) }}</div>
                <div class="mini-stage">{{ stageNumber(m.stage) }}</div>
                <div v-if="m.isSupport" class="mini-support">助战</div>
                <div v-if="m.isFixed" class="mini-fixed">🔒</div>
              </div>
              <div class="mini-cell mini-craft" @contextmenu="openResultContext($event, r, m, 'craft')">
                <img v-if="hasCraftImageId(m.craftId)" :src="craftImagePathId(m.craftId)" class="mini-craft-img" alt="" />
                <span class="mini-craft-name">{{ m.craftName || '无礼装' }}</span>
                <span v-if="!m.isSupport" class="mini-mult">加成 x{{ m.bonusDetail.totalMultiplier.toFixed(2) }}</span>
              </div>
            </div>
          </div>
          <div v-if="expandedResult === r" style="margin-top:8px">
            <pre style="white-space:pre-wrap;font-size:12px">{{ JSON.stringify(r, null, 2) }}</pre>
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
        </div>
        <div class="overlay-grid" :class="overlay.target === 'servant' ? 'servant-grid' : ''">
          <div
            v-for="item in overlayItems"
            :key="item.id"
            class="pick-card"
            :class="overlay.target === 'servant' ? 'servant-pick' : ''"
            @click="overlay.target === 'servant' ? chooseServant(overlay.slotIndex, item.id) : chooseCraft(overlay.slotIndex, item.id)"
            @mouseenter="overlay.target === 'servant' ? showHover($event, item) : null"
            @mousemove="overlay.target === 'servant' ? moveHover($event) : null"
            @mouseleave="hideHover"
          >
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
            :class="{ owned: box[s.id].checked }"
            @click="toggleOwned(s.id)"
            @contextmenu="openBoxContext($event, s)"
            @mouseenter="showHover($event, s)"
            @mousemove="moveHover($event)"
            @mouseleave="hideHover"
          >
            <img v-if="!avatarMissingSet.has(String(s.id))" :src="avatarPath(s.id)" :alt="s.name" class="box-avatar" @error="markAvatarBroken(s.id)" />
            <div v-else class="box-avatar fallback">{{ s.name.charAt(0) }}</div>
            <div v-if="box[s.id].checked" class="box-owned-mark">✔</div>
            <div class="box-sn">{{ s.collectionNo }}</div>

            <div v-if="box[s.id].checked" class="box-maxbond" :class="{ active: box[s.id].maxBond }" @click.stop="toggleMaxBond(s.id)" title="满绊标记">绊</div>
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
            :class="{ owned: batchSelectedServants.includes(s.id) }"
            @click="toggleBatchSelect(s.id)"
            @contextmenu="openBoxContext($event, s)"
            @mouseenter="showHover($event, s)"
            @mousemove="moveHover($event)"
            @mouseleave="hideHover"
          >
            <img v-if="!avatarMissingSet.has(String(s.id))" :src="avatarPath(s.id)" :alt="s.name" class="box-avatar" @error="markAvatarBroken(s.id)" />
            <div v-else class="box-avatar fallback">{{ s.name.charAt(0) }}</div>
            <div v-if="batchSelectedServants.includes(s.id)" class="box-owned-mark">✔</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="secondary" @click="selectAllOwned">全选</button>
          <button class="secondary" @click="batchSelectedServants = []">取消当前选择</button>
          <button class="primary" @click="applyBatchBonus">应用加成</button>
        </div>
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
            :class="{ 'exclusion-active': isExcludedServant(s.id) }"
            @click="toggleExcludeServant(s.id)"
            :title="s.name"
          >
            <img v-if="!avatarMissingSet.has(String(s.id))" :src="avatarPath(s.id)" class="box-avatar" alt="" @error="markAvatarBroken(s.id)" />
            <div v-else class="box-avatar fallback">{{ s.name.charAt(0) }}</div>
            <div class="box-maxbond exclusion-maxbond" :class="{ active: box[s.id].maxBond }" title="满绊标记">绊</div>
            <div class="exclusion-check">{{ isExcludedServant(s.id) ? '✓' : '' }}</div>
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
            <option value="fast">快速（约 3~10 秒）</option>
            <option value="balanced">平衡（约 10~25 秒）</option>
            <option value="high">高质量（约 30~60 秒）</option>
          </select>
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

    <!-- 预设弹窗 -->
    <div v-if="presetModalVisible" class="modal-mask" @click.self="presetModalVisible = false">
      <div class="modal-panel small">
        <div class="overlay-head"><h2>加载预设</h2><button class="secondary" @click="presetModalVisible = false">✕</button></div>
        <div v-if="!presets.length" class="empty">暂无预设</div>
        <div v-for="p in presets" :key="p.id" class="list-row">
          <span>{{ p.name }}</span>
          <span class="text-muted">{{ p.costLimit }}Cost / {{ p.strategy }}</span>
          <button class="secondary" @click="loadPreset(p)">加载</button>
        </div>
      </div>
    </div>

    <!-- 更新数据弹窗 -->
    <div v-if="updateModalVisible" class="modal-mask" @click.self="closeUpdateModal">
      <div class="modal-panel box-modal update-modal">
        <div class="overlay-head">
          <h2>更新数据</h2>
          <button class="secondary" :disabled="updateRunning" @click="closeUpdateModal">✕</button>
        </div>
        <div class="filters">
          <button class="secondary" :disabled="updateRunning" @click="runUpdate(false)">检查并更新</button>
          <button class="secondary" :disabled="updateRunning" @click="runUpdate(true)">强制更新</button>
          <span class="text-muted" style="align-self:center">{{ updateRunning ? '正在更新...' : '空闲' }}</span>
        </div>
        <div v-if="updateError" class="panel error" style="margin-bottom:10px">{{ updateError }}</div>
        <div class="update-items">
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
        <div v-if="updateResult" class="update-result">
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
          <label style="display:flex;gap:6px;margin:6px 0"><input type="checkbox" :checked="box[servantDetail.servantId].maxBond" @change="toggleMaxBond(servantDetail.servantId)" /> 满绊标记（自动包含25%全队加成）</label>
          <label style="display:flex;gap:6px;margin:6px 0"><input type="checkbox" :checked="box[servantDetail.servantId].switch2" :disabled="!box[servantDetail.servantId].maxBond" @change="toggleSwitch2(servantDetail.servantId)" /> 开关二（自身参与收益）</label>
          <div class="field">
            <label>个人加成（%）</label>
            <input type="number" min="0" step="0.01" :value="box[servantDetail.servantId].personalBonus" @change="setPersonal(servantDetail.servantId, $event.target.value)" />
          </div>
          <div v-if="Number(servantDetail.servantId) === 800100" class="field">
            <label>玛修全队光环（%）</label>
            <input type="number" min="0" step="0.01" :value="box[servantDetail.servantId].auraBonus" @change="setAura(servantDetail.servantId, $event.target.value)" />
            <div class="text-muted" style="margin-top:2px">玛修在玩家队伍中时为全队提供该加成；作为助战时不生效。</div>
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

    <!-- 悬停提示 -->
    <div v-if="hover.visible" class="hover-tip" :style="{ left: hover.x + 'px', top: hover.y + 'px' }">{{ hover.text }}</div>

    <!-- 右键菜单 -->
    <div v-if="contextMenu.visible" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
      <div v-if="contextMenu.target === 'box'" class="ctx-item" @click="ctxDetail">⚙️ 从者设置</div>
      <template v-else-if="contextMenu.target === 'result-servant'">
        <div class="ctx-item" @click="ctxSimpleExclude">🚫 简易排除</div>
        <div class="ctx-item" @click="ctxResultInfo">ℹ️ 查看属性</div>
      </template>
      <template v-else-if="contextMenu.target === 'result-craft'">
        <div class="ctx-item" @click="ctxResultInfo">ℹ️ 查看信息</div>
      </template>
      <template v-else>
        <div v-if="contextMenu.target === 'servant' && contextMenu.slotIndex !== null && slots[contextMenu.slotIndex].servantId !== null" class="ctx-item" @click="ctxDetail">⚙️ 从者设置</div>
        <div class="ctx-item" @click="ctxSupport">
          {{ contextMenu.slotIndex !== null && slots[contextMenu.slotIndex].isSupport ? '取消助战' : '设为助战' }}
        </div>
        <div class="ctx-item" @click="ctxReplace">✏️ 更换</div>
        <div class="ctx-item" @click="ctxClear">🗑️ 清空{{ contextMenu.target === 'servant' ? '从者+礼装' : '礼装' }}</div>
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
