// -*- coding: utf-8 -*-
/**
 * analyzer.js － 跑步姿勢「即時」分析核心
 * ==========================================
 * 這個檔案只負責「計算」：
 *   輸入：每一幀 MediaPipe 給的 33 個關節點
 *   輸出：步頻、落腳點、膝蓋、髖、腰（軀幹）、頭、手臂的即時狀態，
 *         以及要講給跑者聽的語音提示、跑完後的總結與練習建議。
 * 鏡頭、畫圖、聲音都在 index.html，這樣分工比較好維護，也能單獨測試。
 *
 * 座標說明：
 *   MediaPipe 給 0～1 的比例座標，這裡一律先乘上影像寬高轉成「像素」，
 *   角度才不會因為畫面比例被拉歪。影像的 y 軸是「往下越大」。
 *
 * ⚠ 所有門檻值（CONFIG）都是一般跑步教學常用的「參考值」，不是醫學標準，
 *   可以依照文獻、教練或物理治療師的建議自行調整。
 */

// ============================================================
// 一、可調整的設定值（改這裡就好，不用動下面的程式）
// ============================================================
export const CONFIG = {
  bufferSec: 8,          // 保留最近幾秒的資料做分析
  windowSec: 10,         // 即時數值用最近幾秒的平均
  warmupSec: 12,         // 開始跑後幾秒內先不提示（讓人先跑穩）
  cueIntervalSec: 20,    // 兩次語音提示之間至少間隔幾秒
  sameCueGapSec: 45,     // 同一個問題至少隔幾秒才會再講一次
  minStrideSec: 0.45,    // 同一隻腳兩次著地最少間隔（秒），避免一步被算兩次

  // ---- 各項門檻（參考值）----
  cadenceLow: 160,       // 步頻（步/分）低於此值 → 提示加快
  overstrideMax: 0.30,   // 著地時腳踝超前髖關節的距離 ÷ 腿長，超過 → 跨步太大
  kneeFlexMin: 10,       // 著地時膝蓋彎曲角度（度）小於此值 → 膝蓋太直
  trunkLeanMin: 0,       // 軀幹前傾（度）小於此值 → 身體後仰
  trunkLeanMax: 15,      // 軀幹前傾（度）大於此值 → 彎腰駝背
  hipExtMin: 8,          // 後腳推蹬時大腿往後的最大角度（度）小於此值 → 髖伸展不足（坐著跑）
  bounceMax: 0.12,       // 髖部上下起伏 ÷ 腿長，超過 → 跳太高
  headForwardMax: 0.30,  // 耳朵超前肩膀的距離 ÷ 軀幹長，超過 → 頭往前探
  elbowMin: 60,          // 手肘角度（度）小於此值 → 手臂夾太緊
  elbowMax: 120,         // 手肘角度（度）大於此值 → 手臂太直
};

// MediaPipe 33 點中會用到的編號（左右指跑者本人的左右）
const IDS = {
  left:  { ear: 7, shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 },
  right: { ear: 8, shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 },
};

// 各項目在畫面上顯示的名稱、對應的身體部位，以及語音提示的優先順序（越前面越重要）
export const METRICS = [
  { key: "overstride", part: "落腳點" },
  { key: "kneeFlex",   part: "膝蓋" },
  { key: "cadence",    part: "步頻" },
  { key: "trunkLean",  part: "腰／軀幹" },
  { key: "hipExt",     part: "髖／臀" },
  { key: "bounce",     part: "上下起伏" },
  { key: "headForward",part: "頭／肩" },
  { key: "elbow",      part: "手臂" },
];

// 每個問題對應：語音提示（跑步中講，要短）＋ 練習建議（跑完看）
export const ADVICE = {
  cadence_low: {
    cue: "步頻偏慢，步伐小一點、快一點",
    drills: ["節拍器跑：跟著節拍跑 1 分鐘、走 1 分鐘，重複 5 次",
             "原地小碎步：快速小步原地踏 20 秒 × 4 組"],
  },
  overstride_high: {
    cue: "腳落在身體正下方，不要往前跨",
    drills: ["A 字跳（A-skip）：抬膝後讓腳往下往後落地，20 公尺 × 4 趟",
             "提高步頻通常會一起改善跨步"],
  },
  kneeFlex_low: {
    cue: "著地時膝蓋放軟，微微彎曲",
    drills: ["安靜著地練習：慢跑時盡量讓腳步聲變小，30 秒 × 4 次",
             "原地彈跳（pogo jump）：膝蓋微彎輕跳 20 下 × 3 組"],
  },
  trunkLean_low: {
    cue: "身體不要後仰，從腳踝整個人微微往前",
    drills: ["靠牆前傾：雙手扶牆、身體打直從腳踝前傾，維持 20 秒 × 3 次"],
  },
  trunkLean_high: {
    cue: "不要彎腰，頭頂往上拉高",
    drills: ["棒式（plank）：30 秒 × 3 組，加強核心",
             "跑步時想像頭頂有一條線把你往上拉"],
  },
  hipExt_low: {
    cue: "臀部出力，後腳往後推",
    drills: ["臀橋（glute bridge）：15 下 × 3 組",
             "弓箭步髖屈肌伸展：每邊 30 秒 × 2 次",
             "B 字跳（B-skip）：20 公尺 × 4 趟"],
  },
  bounce_high: {
    cue: "往前跑，不要往上跳",
    drills: ["提高步頻通常能減少上下起伏",
             "想像頭頂快碰到天花板，保持高度平穩"],
  },
  headForward_high: {
    cue: "收下巴，眼睛看前方",
    drills: ["靠牆站立收下巴：後腦、肩胛、臀貼牆 30 秒 × 3 次",
             "跑步時視線放在前方約 20 公尺"],
  },
  elbow_low: {
    cue: "手臂放鬆，手肘打開一點",
    drills: ["原地擺臂：手肘約 90 度、肩膀放鬆前後擺 30 秒 × 3 次"],
  },
  elbow_high: {
    cue: "手肘彎起來，大約九十度",
    drills: ["原地擺臂：手肘約 90 度、肩膀放鬆前後擺 30 秒 × 3 次"],
  },
};

// ============================================================
// 二、數學小工具
// ============================================================

/** 三點夾角（在 b 點），單位：度。腿完全打直時膝蓋約 180 度。 */
export function angle3(a, b, c) {
  const bax = a[0] - b[0], bay = a[1] - b[1];
  const bcx = c[0] - b[0], bcy = c[1] - b[1];
  const cos = (bax * bcx + bay * bcy) /
              (Math.hypot(bax, bay) * Math.hypot(bcx, bcy) + 1e-9);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

const mean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 移動平均平滑（window = 幀數），減少關節點抖動 */
function smooth(arr, window) {
  const w = Math.max(1, Math.round(window));
  if (w <= 1) return arr.slice();
  const half = Math.floor(w / 2);
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    return s / n;
  });
}

/** 找局部最大值（腳踝 y 最大 ≈ 腳在最低點 ≈ 踩在地上） */
function findPeaks(sig, minDist) {
  const sorted = [...sig].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.6)];  // 只看「腳比較低」的時段
  const half = Math.max(1, Math.floor(minDist / 2));
  const peaks = [];
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] < threshold) continue;
    let isMax = true;
    for (let j = Math.max(0, i - half); j <= Math.min(sig.length - 1, i + half); j++) {
      if (sig[j] > sig[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < minDist) {
      if (sig[i] > sig[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
    } else {
      peaks.push(i);
    }
  }
  return peaks;
}

// ============================================================
// 三、即時分析器
// ============================================================

export class RunAnalyzer {
  constructor(config = {}) {
    this.cfg = { ...CONFIG, ...config };
    this.reset();
  }

  /** 開始新的一次跑步時呼叫，清空所有資料 */
  reset() {
    this.buffer = [];          // 最近幾秒的每一幀資料
    this.contacts = [];        // 每次著地：{ t, kneeFlex, overstride }
    this.strides = [];         // 每個跨步：{ t, hipExt, bounce }
    this.posture = [];         // 姿勢取樣：{ t, trunkLean, headForward, elbow }
    this.visL = 0; this.visR = 0;
    this.side = null;          // 分析哪一隻腳（靠近鏡頭那隻）
    this.startT = null;
    this.lastAnalyzeT = -1;
    this.lastCueT = -Infinity;
    this.lastSpoken = {};      // 每個提示上次講的時間
    this.direction = 1;        // 1 = 往畫面右邊跑，-1 = 往左
    this.legLen = null;
  }

  /**
   * 每一幀呼叫一次。
   * @param {Array} lms  MediaPipe 的 33 個點（{x, y, visibility}），沒偵測到人就傳 null
   * @param {number} t   目前時間（秒）
   * @param {number} w,h 影像寬高（像素）
   */
  addFrame(lms, t, w, h) {
    if (this.startT === null) this.startT = t;
    if (!lms) return;

    // 把需要的點轉成像素座標，左右兩邊都存
    const frame = { t, left: {}, right: {} };
    for (const side of ["left", "right"]) {
      for (const [name, id] of Object.entries(IDS[side])) {
        frame[side][name] = [lms[id].x * w, lms[id].y * h];
      }
    }
    // 用「可見度」的移動平均判斷哪隻腳靠近鏡頭
    const vl = (lms[27].visibility ?? 1) + (lms[25].visibility ?? 1);
    const vr = (lms[28].visibility ?? 1) + (lms[26].visibility ?? 1);
    this.visL = this.visL * 0.95 + vl * 0.05;
    this.visR = this.visR * 0.95 + vr * 0.05;
    // 前 3 秒持續判斷，之後鎖定，避免中途換邊造成數值跳動
    if (this.side === null || t - this.startT < 3) {
      this.side = this.visL >= this.visR ? "left" : "right";
    }

    this.buffer.push(frame);
    while (this.buffer.length && t - this.buffer[0].t > this.cfg.bufferSec) this.buffer.shift();

    // 每 0.25 秒做一次分析（每幀都算太耗手機效能）
    if (t - this.lastAnalyzeT >= 0.25) {
      this.lastAnalyzeT = t;
      this._analyze(t);
    }
  }

  /** 核心分析：找著地、算各部位指標 */
  _analyze(now) {
    const buf = this.buffer;
    if (buf.length < 20) return;
    const S = this.side;
    const get = (part) => buf.map((f) => f[S][part]);
    const hip = get("hip"), knee = get("knee"), ankle = get("ankle");
    const heel = get("heel"), toe = get("toe");
    const sh = get("shoulder"), ear = get("ear"), elbow = get("elbow"), wrist = get("wrist");

    const fps = (buf.length - 1) / (buf[buf.length - 1].t - buf[0].t);

    // 跑步方向：腳尖在腳跟的哪一側
    this.direction = median(toe.map((p, i) => p[0] - heel[i][0])) >= 0 ? 1 : -1;
    const dir = this.direction;

    // 腿長、軀幹長：用來把距離「標準化」，不受人離鏡頭遠近影響
    const legLen = median(hip.map((p, i) =>
      Math.hypot(p[0] - knee[i][0], p[1] - knee[i][1]) +
      Math.hypot(knee[i][0] - ankle[i][0], knee[i][1] - ankle[i][1])));
    const torsoLen = median(hip.map((p, i) => Math.hypot(p[0] - sh[i][0], p[1] - sh[i][1])));
    this.legLen = legLen;

    // ---- 1. 找著地 ----
    const ankleRaw = ankle.map((p) => p[1]);
    const ankleY = smooth(ankleRaw, fps / 15);
    const minDist = Math.round(fps * this.cfg.minStrideSec);
    const peaks = findPeaks(ankleY, minDist);
    const lagFrames = Math.round(fps * 0.15);   // 太靠近最新一幀的峰值還不確定，先不算

    for (const p of peaks) {
      if (p > buf.length - 1 - lagFrames) continue;
      // 從最低點往回找「剛碰到地」的那一幀
      // （往回找時用「未平滑」的腳踝高度，平滑會讓著地時間被往前拉，膝蓋角度就不準）
      let c = p;
      while (c > 0 && ankleRaw[c - 1] > ankleY[p] - 0.03 * legLen) c--;
      // 往回找到資料最開頭還沒找到「落地前」→ 這次著地的開頭被截掉了，時間不準，跳過
      if (c <= 1) continue;
      const tc = buf[c].t;
      // 已經記錄過的著地就跳過（同一次著地在不同次分析中會重複出現）
      if (this.contacts.some((k) => Math.abs(k.t - tc) < this.cfg.minStrideSec * 0.6)) continue;

      const kneeFlex = 180 - angle3(hip[c], knee[c], ankle[c]);
      const overstride = (ankle[c][0] - hip[c][0]) * dir / legLen;
      const prev = this.contacts[this.contacts.length - 1];
      this.contacts.push({ t: tc, kneeFlex, overstride });
      this.contacts.sort((a, b) => a.t - b.t);

      // ---- 2. 跨步指標：上一次著地到這一次之間 ----
      if (prev && tc > prev.t && tc - prev.t < 2.5) {
        let maxExt = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < buf.length; i++) {
          if (buf[i].t < prev.t || buf[i].t > tc) continue;
          // 大腿往後的角度：膝蓋在髖關節「後方」為正
          const ext = Math.atan2((hip[i][0] - knee[i][0]) * dir, knee[i][1] - hip[i][1]) * 180 / Math.PI;
          maxExt = Math.max(maxExt, ext);
          minY = Math.min(minY, hip[i][1]);
          maxY = Math.max(maxY, hip[i][1]);
        }
        if (isFinite(maxExt)) {
          this.strides.push({ t: tc, hipExt: maxExt, bounce: (maxY - minY) / legLen });
        }
      }
    }

    // ---- 3. 姿勢（用最近 1 秒的中位數，比較穩定）----
    const recent = [];
    for (let i = 0; i < buf.length; i++) if (now - buf[i].t <= 1) recent.push(i);
    if (recent.length >= 5) {
      // 軀幹前傾：肩→髖連線跟垂直線的夾角，往前傾為正
      const trunk = median(recent.map((i) =>
        Math.atan2((sh[i][0] - hip[i][0]) * dir, hip[i][1] - sh[i][1]) * 180 / Math.PI));
      // 頭往前探：耳朵超前肩膀多少（÷ 軀幹長）
      const head = median(recent.map((i) => (ear[i][0] - sh[i][0]) * dir / torsoLen));
      // 手肘角度
      const elb = median(recent.map((i) => angle3(sh[i], elbow[i], wrist[i])));
      this.posture.push({ t: now, trunkLean: trunk, headForward: head, elbow: elb });
    }
  }

  /** 取得最近 windowSec 秒的即時數值 */
  getMetrics(now) {
    const W = this.cfg.windowSec;
    const cs = this.contacts.filter((c) => now - c.t <= W);
    const ss = this.strides.filter((s) => now - s.t <= W);
    const ps = this.posture.filter((p) => now - p.t <= 3);   // 姿勢只看最近 3 秒，反應較快

    let cadence = null;
    if (cs.length >= 3) {
      const dur = cs[cs.length - 1].t - cs[0].t;
      if (dur > 0) cadence = (cs.length - 1) * 2 / dur * 60;  // 一隻腳著地兩次 = 一個跨步 = 兩步
    }
    return {
      cadence,
      overstride: mean(cs.map((c) => c.overstride)),
      kneeFlex: mean(cs.map((c) => c.kneeFlex)),
      hipExt: mean(ss.map((s) => s.hipExt)),
      bounce: mean(ss.map((s) => s.bounce)),
      trunkLean: median(ps.map((p) => p.trunkLean)),
      headForward: median(ps.map((p) => p.headForward)),
      elbow: median(ps.map((p) => p.elbow)),
    };
  }

  /**
   * 判斷每一項是「正常 ok」、「需注意 warn」還是「資料不足 na」。
   * 回傳陣列，每項：{ key, part, status, value, display, issue }
   * issue 是 ADVICE 的 key（例如 "cadence_low"），沒問題就是 null
   */
  evaluate(m) {
    const c = this.cfg;
    const out = [];
    const add = (key, value, display, issue) => {
      const part = METRICS.find((x) => x.key === key).part;
      out.push({ key, part, value, display,
                 status: value === null ? "na" : issue ? "warn" : "ok",
                 issue: value === null ? null : issue });
    };
    const f0 = (v) => v.toFixed(0), f2 = (v) => v.toFixed(2);

    add("overstride", m.overstride, m.overstride !== null ? `${f2(m.overstride)} 倍腿長` : "--",
        m.overstride !== null && m.overstride > c.overstrideMax ? "overstride_high" : null);
    add("kneeFlex", m.kneeFlex, m.kneeFlex !== null ? `著地彎 ${f0(m.kneeFlex)}°` : "--",
        m.kneeFlex !== null && m.kneeFlex < c.kneeFlexMin ? "kneeFlex_low" : null);
    add("cadence", m.cadence, m.cadence !== null ? `${f0(m.cadence)} 步/分` : "--",
        m.cadence !== null && m.cadence < c.cadenceLow ? "cadence_low" : null);

    let trunkIssue = null;
    if (m.trunkLean !== null) {
      if (m.trunkLean < c.trunkLeanMin) trunkIssue = "trunkLean_low";
      else if (m.trunkLean > c.trunkLeanMax) trunkIssue = "trunkLean_high";
    }
    add("trunkLean", m.trunkLean, m.trunkLean !== null ? `前傾 ${f0(m.trunkLean)}°` : "--", trunkIssue);

    add("hipExt", m.hipExt, m.hipExt !== null ? `後推 ${f0(m.hipExt)}°` : "--",
        m.hipExt !== null && m.hipExt < c.hipExtMin ? "hipExt_low" : null);
    add("bounce", m.bounce, m.bounce !== null ? `${f2(m.bounce)} 倍腿長` : "--",
        m.bounce !== null && m.bounce > c.bounceMax ? "bounce_high" : null);
    add("headForward", m.headForward, m.headForward !== null ? `頭前探 ${f2(m.headForward)}` : "--",
        m.headForward !== null && m.headForward > c.headForwardMax ? "headForward_high" : null);

    let elbowIssue = null;
    if (m.elbow !== null) {
      if (m.elbow < c.elbowMin) elbowIssue = "elbow_low";
      else if (m.elbow > c.elbowMax) elbowIssue = "elbow_high";
    }
    add("elbow", m.elbow, m.elbow !== null ? `手肘 ${f0(m.elbow)}°` : "--", elbowIssue);
    return out;
  }

  /**
   * 決定現在要不要講話、講什麼。一次只講一件最重要的事。
   * 回傳要講的句子，不需要講就回傳 null。
   */
  pickCue(now, evals) {
    if (now - this.startT < this.cfg.warmupSec) return null;
    if (now - this.lastCueT < this.cfg.cueIntervalSec) return null;

    // 依 METRICS 的優先順序，找第一個「有問題、而且最近沒講過」的
    for (const { key } of METRICS) {
      const e = evals.find((x) => x.key === key);
      if (!e || e.status !== "warn") continue;
      if (now - (this.lastSpoken[e.issue] ?? -Infinity) < this.cfg.sameCueGapSec) continue;
      this.lastCueT = now;
      this.lastSpoken[e.issue] = now;
      return ADVICE[e.issue].cue;
    }
    // 全部正常 → 給一句鼓勵（資料要夠才講）
    const valid = evals.filter((e) => e.status !== "na").length;
    if (valid >= 4 && evals.every((e) => e.status !== "warn")) {
      this.lastCueT = now;
      return "姿勢很好，保持下去";
    }
    return null;
  }

  /** 跑完後的總結：各項平均值、出問題的比例、最該先改的一項與練習建議 */
  summary() {
    const avg = (arr, k) => mean(arr.map((x) => x[k]));
    const cs = this.contacts;
    let cadence = null;
    // 整段步頻：只用相鄰著地間隔合理的部分（中途停下來的空檔不算）
    const gaps = [];
    for (let i = 1; i < cs.length; i++) {
      const g = cs[i].t - cs[i - 1].t;
      if (g > this.cfg.minStrideSec * 0.6 && g < 2.5) gaps.push(g);
    }
    if (gaps.length >= 2) cadence = 2 / mean(gaps) * 60;

    const m = {
      cadence,
      overstride: avg(cs, "overstride"),
      kneeFlex: avg(cs, "kneeFlex"),
      hipExt: avg(this.strides, "hipExt"),
      bounce: avg(this.strides, "bounce"),
      trunkLean: avg(this.posture, "trunkLean"),
      headForward: avg(this.posture, "headForward"),
      elbow: avg(this.posture, "elbow"),
    };
    const evals = this.evaluate(m);
    const issues = evals.filter((e) => e.status === "warn");
    const top = issues[0] || null;   // evaluate 的順序就是優先順序
    const end = this.buffer.length ? this.buffer[this.buffer.length - 1].t : this.startT;
    return {
      durationSec: this.startT !== null ? end - this.startT : 0,
      steps: cs.length * 2,
      side: this.side,
      metrics: m,
      evals,
      topIssue: top ? { part: top.part, issue: top.issue, ...ADVICE[top.issue] } : null,
      otherIssues: issues.slice(1).map((e) => ({ part: e.part, issue: e.issue, ...ADVICE[e.issue] })),
    };
  }
}
