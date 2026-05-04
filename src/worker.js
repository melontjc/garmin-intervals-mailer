const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";
const RESEND_URL = "https://api.resend.com/emails";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "garmin-intervals-mailer",
        ai: Boolean(env.OPENAI_API_KEY),
        bindings: {
          intervals: "INTERVALS_API_KEY" in env,
          resend: "RESEND_API_KEY" in env,
          openai: "OPENAI_API_KEY" in env,
          openaiModel: env.OPENAI_MODEL || null
        }
      });
    }
    if (url.pathname === "/run") {
      const result = await runAnalysis(env, {
        force: boolParam(url, "force"),
        dryRun: boolParam(url, "dry"),
        maxRides: intParam(url, "max", 6)
      });
      return json(result);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runAnalysis(env, { force: false, dryRun: false, maxRides: 6 }));
  }
};

async function runAnalysis(env, options = {}) {
  requireEnv(env, ["INTERVALS_API_KEY", "RESEND_API_KEY", "RECIPIENT_EMAIL", "RESEND_FROM"]);

  const athleteId = env.INTERVALS_ATHLETE_ID || "0";
  const processRange = dateRange(3, 1);
  const historyRange = dateRange(56, 1);
  const activities = await intervalsFetch(env, `/athlete/${athleteId}/activities?oldest=${historyRange.oldest}&newest=${historyRange.newest}`);
  const rides = (Array.isArray(activities) ? activities : [])
    .filter(isCyclingActivity)
    .sort(byNewestActivity);
  const processable = rides
    .filter((activity) => inDateRange(activityDate(activity), processRange.oldest, processRange.newest))
    .slice(0, options.maxRides || 6);
  const wellnessDays = await fetchWellnessRange(env, athleteId, historyRange.oldest, historyRange.newest);

  const sent = [];
  const skipped = [];
  const previews = [];

  for (const activity of processable) {
    const activityId = getActivityId(activity);
    if (!activityId) {
      skipped.push({ reason: "missing-id", name: activity.name });
      continue;
    }

    const kvKey = `sent:${activityId}`;
    const alreadySent = await env.SENT_ACTIVITIES.get(kvKey);
    if (alreadySent && !options.force) {
      skipped.push({ reason: "already-sent", id: activityId, name: activity.name });
      continue;
    }

    const detail = await safeIntervalsFetch(env, `/activity/${activityId}`);
    const activityData = detail && typeof detail === "object" ? { ...activity, ...detail } : activity;
    const analysis = buildAnalysis(activityData, rides, wellnessDays);
    const aiReport = await buildAiCoachReport(env, analysis);
    const report = buildEmailReport(analysis, aiReport);

    if (options.dryRun) {
      previews.push({ id: activityId, subject: report.subject, analysis, aiReport });
      continue;
    }

    await sendEmail(env, report.subject, report.html, report.text);
    await env.SENT_ACTIVITIES.put(kvKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 180 });
    sent.push({ id: activityId, name: analysis.activity.name, subject: report.subject, ai: aiReport.source });
  }

  return { ok: true, sent, skipped, previews, checked: processable.length, aiEnabled: Boolean(env.OPENAI_API_KEY) };
}

function buildAnalysis(activity, historyRides, wellnessDays) {
  const activitySummary = summarizeActivity(activity);
  const history = summarizeHistory(historyRides, activitySummary.date);
  const wellness = summarizeWellness(wellnessDays, activitySummary.date);
  const structure = inferRideStructure(activitySummary);
  const recovery = inferRecovery(activitySummary, history, wellness);
  const dataQuality = inferDataQuality(activitySummary, activity);

  return {
    generatedAt: new Date().toISOString(),
    equipmentContext: {
      heartRate: "Garmin Forerunner 255 as heart-rate source",
      headUnit: "Garmin Edge 540 as ride recorder",
      power: "Dual-sided pedal power meter"
    },
    activity: activitySummary,
    structure,
    history,
    wellness,
    recovery,
    dataQuality
  };
}

function summarizeActivity(activity) {
  const date = activityDate(activity);
  const movingTime = seconds(firstNumber(activity.moving_time, activity.elapsed_time, activity.duration));
  const distanceKm = km(firstNumber(activity.distance, activity.icu_distance));
  const load = firstNumber(activity.icu_training_load, activity.training_load, activity.tss);
  const intensity = normalizeIntensity(firstNumber(activity.icu_intensity, activity.intensity, activity.if));
  const avgPower = firstNumber(activity.average_watts, activity.avg_watts, activity.icu_average_watts);
  const weightedPower = firstNumber(activity.weighted_average_watts, activity.normalized_power, activity.icu_weighted_avg_watts, activity.icu_weighted_power);
  const maxPower = firstNumber(activity.max_watts, activity.max_power);
  const avgHr = firstNumber(activity.average_heartrate, activity.avg_hr, activity.icu_average_heartrate);
  const maxHr = firstNumber(activity.max_heartrate, activity.max_hr);
  const avgCadence = firstNumber(activity.average_cadence, activity.avg_cadence, activity.icu_average_cadence);
  const elevation = firstNumber(activity.total_elevation_gain, activity.elevation_gain, activity.icu_elevation);
  const calories = firstNumber(activity.calories, activity.kcal);
  const kilojoules = firstNumber(activity.kilojoules, activity.work);
  const decoupling = normalizePercent(firstNumber(activity.decoupling, activity.power_hr_decoupling, activity.aerobic_decoupling, activity.icu_decoupling));
  const ftp = firstNumber(activity.ftp, activity.icu_ftp, activity.athlete_ftp);

  return {
    id: getActivityId(activity),
    name: activity.name || "骑行",
    date,
    type: activity.type || activity.sport || activity.icu_sport || "ride",
    distanceKm,
    movingTimeSec: movingTime,
    movingTimeText: formatDuration(movingTime),
    elevationM: elevation,
    avgPowerW: avgPower,
    weightedPowerW: weightedPower,
    maxPowerW: maxPower,
    avgHr,
    maxHr,
    avgCadence,
    load,
    intensity,
    calories,
    kilojoules,
    decouplingPct: decoupling,
    ftpW: ftp,
    powerHrEfficiency: avgHr && weightedPower ? weightedPower / avgHr : null,
    leftRightBalance: firstNumber(activity.avg_lr_balance, activity.left_right_balance, activity.lr_balance, findByKeyHint(activity, ["balance"])),
    powerPeaks: powerPeaks(activity),
    zoneHints: zoneHints(activity),
    rawFieldHints: fieldHints(activity)
  };
}

function summarizeHistory(rides, activityDateValue) {
  const previous = rides.filter((ride) => activityDate(ride) <= activityDateValue);
  const last7 = previous.filter((ride) => daysBetween(activityDate(ride), activityDateValue) <= 7);
  const last28 = previous.filter((ride) => daysBetween(activityDate(ride), activityDateValue) <= 28);
  const last42 = previous.filter((ride) => daysBetween(activityDate(ride), activityDateValue) <= 42);
  const loads7 = last7.map((ride) => firstNumber(ride.icu_training_load, ride.training_load, ride.tss)).filter(isNumber);
  const loads28 = last28.map((ride) => firstNumber(ride.icu_training_load, ride.training_load, ride.tss)).filter(isNumber);
  const intensities28 = last28.map((ride) => normalizeIntensity(firstNumber(ride.icu_intensity, ride.intensity, ride.if))).filter(isNumber);

  return {
    rides7d: last7.length,
    rides28d: last28.length,
    load7d: sum(loads7),
    load28d: sum(loads28),
    avgLoad28d: average(loads28),
    avgIntensity28d: average(intensities28),
    loadRamp: loads28.length ? sum(loads7) - sum(loads28) / 4 : null,
    recentHighLoadCount: last28.filter((ride) => firstNumber(ride.icu_training_load, ride.training_load, ride.tss) >= 100).length,
    recentRides: last42.slice(0, 8).map((ride) => ({
      date: activityDate(ride),
      name: ride.name || "骑行",
      distanceKm: km(firstNumber(ride.distance, ride.icu_distance)),
      load: firstNumber(ride.icu_training_load, ride.training_load, ride.tss),
      intensity: normalizeIntensity(firstNumber(ride.icu_intensity, ride.intensity, ride.if))
    }))
  };
}

function summarizeWellness(wellnessDays, activityDateValue) {
  const days = Array.isArray(wellnessDays) ? wellnessDays : [];
  const dated = days
    .map((item) => ({ ...item, date: localDate(item.id || item.date || item.day || item.start_date || "") }))
    .filter((item) => item.date);
  const current = dated.find((item) => item.date === activityDateValue) || null;
  const last7 = dated.filter((item) => daysBetween(item.date, activityDateValue) <= 7);
  const hrvToday = positiveNumber(current?.hrv, current?.hrvRMSSD, current?.hrv_rmssd);
  const restingHrToday = rangeNumber(25, 120, current?.restingHR, current?.resting_hr, current?.restingHeartRate);
  const sleepSecToday = rangeNumber(60 * 60, 14 * 60 * 60, current?.sleepSecs, current?.sleep_seconds, current?.sleep);
  const hrv7 = average(last7.map((item) => positiveNumber(item.hrv, item.hrvRMSSD, item.hrv_rmssd)).filter(isNumber));
  const restingHr7 = average(last7.map((item) => rangeNumber(25, 120, item.restingHR, item.resting_hr, item.restingHeartRate)).filter(isNumber));
  const sleep7 = average(last7.map((item) => rangeNumber(60 * 60, 14 * 60 * 60, item.sleepSecs, item.sleep_seconds, item.sleep)).filter(isNumber));

  return {
    available: Boolean(current || last7.length),
    date: activityDateValue,
    hrvToday,
    hrv7dAvg: hrv7,
    hrvDeltaPct: hrvToday && hrv7 ? ((hrvToday - hrv7) / hrv7) * 100 : null,
    restingHrToday,
    restingHr7dAvg: restingHr7,
    restingHrDelta: restingHrToday && restingHr7 ? restingHrToday - restingHr7 : null,
    sleepTodaySec: sleepSecToday,
    sleep7dAvgSec: sleep7,
    sleepDebtSec: sleepSecToday && sleep7 ? sleepSecToday - sleep7 : null
  };
}

function inferRideStructure(activity) {
  const { load, intensity, movingTimeSec, decouplingPct, avgPowerW, weightedPowerW } = activity;
  const variabilityIndex = avgPowerW && weightedPowerW ? weightedPowerW / avgPowerW : null;
  let label = "有氧训练";
  let purpose = "基础有氧积累";

  if (!avgPowerW && !load) {
    label = "基础记录";
    purpose = "数据不足，优先检查功率计和心率数据完整性";
  } else if (intensity >= 0.9) {
    label = "高强度/比赛式刺激";
    purpose = "明显推动疲劳和适应，适合作为重点训练日";
  } else if (load >= 130 && intensity < 0.75) {
    label = "长距离高负荷耐力骑";
    purpose = "以时间和爬升累积训练压力，主要刺激耐力和抗疲劳能力";
  } else if (load >= 130) {
    label = "高负荷质量训练";
    purpose = "训练负荷较高，对疲劳和适应都有明显推动";
  } else if (intensity >= 0.84) {
    label = "阈值/甜区训练";
    purpose = "提升持续输出能力和乳酸阈附近耐受";
  } else if (intensity >= 0.72) {
    label = "节奏/甜区偏下";
    purpose = "兼顾耐力和肌肉耐受，疲劳中等";
  } else if (movingTimeSec >= 7200 && intensity < 0.75) {
    label = "耐力骑";
    purpose = "有氧基础、脂代谢和长时间稳定输出";
  } else if (load <= 35 || intensity <= 0.6) {
    label = "恢复/轻松骑";
    purpose = "促进恢复或保持骑感";
  }

  const notes = [];
  if (variabilityIndex && variabilityIndex > 1.12) notes.push("功率波动偏大，可能有爬坡、跟骑、红绿灯或冲刺影响。");
  if (decouplingPct != null && decouplingPct > 7) notes.push("Power/HR 漂移偏高，长距离补给、热环境或疲劳可能影响后半程。");
  if (decouplingPct != null && decouplingPct <= 5 && movingTimeSec >= 5400) notes.push("有氧耦合稳定，耐力基础和配速控制表现不错。");

  return { label, purpose, variabilityIndex, notes };
}

function inferRecovery(activity, history, wellness) {
  let level = "normal";
  const reasons = [];
  const nextDay = [];

  if (activity.intensity >= 0.9 || activity.load >= 150) {
    level = "high";
    reasons.push("本次训练负荷或强度较高。");
    nextDay.push("明天优先休息，或 45-75 分钟 Z1-Z2 恢复骑。");
  } else if (activity.load >= 80 || history.load7d >= 350) {
    level = "moderate";
    reasons.push("本次有明确训练刺激，且近期负荷需要留意。");
    nextDay.push("明天可以低强度有氧；如果晨起腿沉，取消强度课。");
  } else {
    nextDay.push("如果睡眠和主观疲劳正常，明天可以按计划训练。");
  }

  if (wellness.hrvDeltaPct != null && wellness.hrvDeltaPct < -12) {
    level = "high";
    reasons.push("HRV 低于近 7 日均值较多。");
    nextDay.push("避免阈值、VO2max 和冲刺训练。");
  }
  if (wellness.restingHrDelta != null && wellness.restingHrDelta >= 5) {
    level = "high";
    reasons.push("静息心率高于近 7 日均值。");
  }
  if (activity.decouplingPct != null && activity.decouplingPct > 7) {
    reasons.push("Power/HR 漂移提示后程压力偏大。");
  }

  return {
    level,
    reasons,
    nextDay,
    nutrition: nutritionAdvice(activity),
    sleep: level === "high" ? "今晚优先保证睡眠时长和连续性，睡前避免额外压力刺激。" : "保持正常睡眠节律即可。"
  };
}

function inferDataQuality(activity, raw) {
  const missing = [];
  if (!activity.avgPowerW) missing.push("平均功率");
  if (!activity.weightedPowerW) missing.push("标准化/加权功率");
  if (!activity.avgHr) missing.push("平均心率");
  if (!activity.load) missing.push("训练负荷");
  if (!activity.intensity) missing.push("强度系数");
  if (!activity.leftRightBalance) missing.push("左右功率平衡");

  return {
    completeness: missing.length <= 1 ? "good" : missing.length <= 3 ? "partial" : "poor",
    missing,
    note: missing.length ? `缺少字段：${missing.join("、")}。如果 Intervals.icu 页面能看到但邮件没有，下一步需要适配对应 API 字段名。` : "关键字段完整。"
  };
}

async function buildAiCoachReport(env, analysis) {
  const fallback = buildRuleCoachReport(analysis);
  if (!env.OPENAI_API_KEY) return { source: "rules", markdown: fallback };

  try {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4.1-mini",
        max_output_tokens: 1600,
        instructions: "你是一名严谨但表达有活力的自行车训练分析师。只基于用户提供的 JSON 数据分析，不要编造缺失指标。输出中文，结构清晰，给出具体但不过度医疗化的训练和恢复建议。语气可以像私人教练，专业、轻快、有一点鼓励感。",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "请为下面这次骑行写一份专业训练分析邮件正文。邮件前面已经有一块图标化活动快照，所以正文不要重复堆指标，要把指标翻译成训练含义。",
                  "1. 先给一句有画面感的总评。",
                  "2. 判断本次训练目的和效果。",
                  "3. 分析功率、心率、训练负荷、Power/HR 漂移、近期负荷和健康状态。",
                  "4. 给出明天训练建议、恢复建议、补给建议。",
                  "5. 指出数据缺口，尤其是左右功率、功率区间、峰值功率缺失时要说明。",
                  "6. 可以少量使用 emoji 或符号，但不要过度花哨。",
                  "7. 不要说自己是 AI，不要引用 JSON，不要写免责声明。",
                  "",
                  JSON.stringify(analysis, null, 2)
                ].join("\n")
              }
            ]
          }
        ]
      })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const markdown = extractResponseText(data);
    return { source: "openai", markdown: markdown || fallback };
  } catch (error) {
    return { source: "rules-fallback", error: error.message, markdown: `${fallback}\n\n> AI 分析暂时失败，已使用规则版建议。错误：${error.message}` };
  }
}

function buildRuleCoachReport(analysis) {
  const { activity, structure, history, wellness, recovery, dataQuality } = analysis;
  return [
    `## 总评`,
    `这次是一次${structure.label}，主要目的偏向${structure.purpose}。训练负荷为 ${format(activity.load, 0)}，强度系数为 ${format(activity.intensity, 2)}，整体恢复压力判断为 ${recovery.level}。`,
    "",
    `## 训练解读`,
    `距离 ${format(activity.distanceKm, 1)} km，移动时间 ${activity.movingTimeText}，加权功率 ${watts(activity.weightedPowerW)}，平均心率 ${format(activity.avgHr, 0)} bpm。`,
    ...structure.notes.map((note) => `- ${note}`),
    `近 7 天训练负荷约 ${format(history.load7d, 0)}，近 28 天训练负荷约 ${format(history.load28d, 0)}。`,
    "",
    `## 明天建议`,
    ...recovery.nextDay.map((item) => `- ${item}`),
    `- ${recovery.sleep}`,
    ...recovery.nutrition.map((item) => `- ${item}`),
    "",
    `## 数据质量`,
    `- ${dataQuality.note}`,
    wellness.available ? `- HRV 今日 ${format(wellness.hrvToday, 0)} ms，静息心率 ${format(wellness.restingHrToday, 0)} bpm，睡眠 ${formatDuration(wellness.sleepTodaySec)}。` : "- 未读取到当天 Garmin 健康数据。"
  ].join("\n");
}

function buildLivelySummary(analysis) {
  const { activity, structure, history, wellness, recovery, dataQuality } = analysis;
  const recoveryHours = estimateRecoveryHours(activity, recovery, wellness);
  const statusLine = trainingStatusLine(recovery, history, wellness);
  const peakLines = peakPowerLines(activity);
  const zoneLines = compactZoneLines(activity.zoneHints);
  const heartLine = wellness.available
    ? `💚 HRV ${format(wellness.hrvToday, 0)}ms｜静息心率 ${format(wellness.restingHrToday, 0)}bpm｜睡眠 ${formatDuration(wellness.sleepTodaySec)}`
    : "💚 健康数据暂缺，恢复判断主要基于本次训练负荷";
  const balance = activity.leftRightBalance == null ? "暂无" : `${format(activity.leftRightBalance, 1)} / ${format(100 - activity.leftRightBalance, 1)}`;

  const sections = [
    {
      title: "📌 今日训练状态",
      lines: [
        `${statusLine.icon} ${statusLine.text}`,
        `📊 近7天负荷 ${format(history.load7d, 0)}｜近28天负荷 ${format(history.load28d, 0)}｜恢复压力 ${recovery.level}`,
        heartLine
      ]
    },
    {
      title: "🚴 骑行总结",
      lines: [
        `🎯 ${structure.label}｜${structure.purpose}`,
        `📍 ${format(activity.distanceKm, 1)}km｜${activity.movingTimeText}｜爬升 ${format(activity.elevationM, 0)}m`,
        `⚡ 加权功率 ${watts(activity.weightedPowerW)}｜强度 ${format(activity.intensity, 2)}｜负荷 ${format(activity.load, 0)}`,
        `❤️ 心率 ${format(activity.avgHr, 0)}/${format(activity.maxHr, 0)}bpm｜踏频 ${format(activity.avgCadence, 0)}rpm｜左右 ${balance}`,
        `✨ 预计恢复时间 ${recoveryHours} 小时`
      ]
    },
    { title: "⚡ 峰值功率", lines: peakLines },
    { title: "🌈 区间分布", lines: zoneLines },
    {
      title: "🔎 数据提示",
      lines: [
        dataQuality.note,
        activity.decouplingPct == null ? "Power/HR 漂移暂无" : `Power/HR 漂移 ${format(activity.decouplingPct, 1)}%，后程心率压力需要留意`
      ]
    }
  ];

  const html = `
    <section style="background:#f7fbfb;border:1px solid #dcebea;border-radius:12px;padding:16px;margin:0 0 20px">
      <h3 style="margin:0 0 12px;color:#184e4a">🧾 活动快照</h3>
      ${sections.map((section) => `
        <div style="margin:14px 0 0">
          <div style="font-weight:700;color:#2c3e50;margin-bottom:6px">${section.title}</div>
          <div style="color:#25313b">${section.lines.map((line) => `<div style="margin:3px 0">${escapeHtml(line)}</div>`).join("")}</div>
        </div>
      `).join("")}
    </section>`;

  const text = [
    "🧾 活动快照",
    ...sections.flatMap((section) => [section.title, ...section.lines.map((line) => `- ${line}`), ""])
  ].join("\n");

  return { html, text };
}

function buildEmailReport(analysis, aiReport) {
  const { activity, structure, history, wellness, dataQuality } = analysis;
  const livelySummary = buildLivelySummary(analysis);
  const subject = `骑行分析｜${activity.date} ${format(activity.distanceKm, 1)}km / ${structure.label}`;
  const metrics = [
    ["骑行名称", escapeHtml(activity.name)],
    ["距离", `${format(activity.distanceKm, 1)} km`],
    ["移动时间", activity.movingTimeText],
    ["爬升", `${format(activity.elevationM, 0)} m`],
    ["平均功率", watts(activity.avgPowerW)],
    ["加权/标准化功率", watts(activity.weightedPowerW)],
    ["平均/最大心率", hrPair(activity.avgHr, activity.maxHr)],
    ["平均踏频", activity.avgCadence == null ? "暂无" : `${format(activity.avgCadence, 0)} rpm`],
    ["训练负荷", format(activity.load, 0)],
    ["强度系数", format(activity.intensity, 2)],
    ["Power/HR 漂移", activity.decouplingPct == null ? "暂无" : `${format(activity.decouplingPct, 1)}%`],
    ["近 7 天负荷", format(history.load7d, 0)],
    ["近 28 天负荷", format(history.load28d, 0)],
    ["HRV 今日/7日均值", wellness.available ? `${format(wellness.hrvToday, 0)} / ${format(wellness.hrv7dAvg, 0)} ms` : "暂无"],
    ["静息心率 今日/7日均值", wellness.available ? `${format(wellness.restingHrToday, 0)} / ${format(wellness.restingHr7dAvg, 0)} bpm` : "暂无"],
    ["数据完整度", dataQuality.completeness]
  ];

  const html = `
    <main style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.6;color:#17202a;max-width:760px">
      <h2 style="margin:0 0 8px">骑行分析｜${activity.date}</h2>
      <p style="margin:0 0 18px;color:#566573">${escapeHtml(activity.name)} · ${aiReport.source}</p>
      ${livelySummary.html}
      <h3>关键指标</h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
        ${metrics.map(([label, value]) => `<tr><td style="border-bottom:1px solid #e5e8e8;padding:8px;color:#566573">${label}</td><td style="border-bottom:1px solid #e5e8e8;padding:8px;text-align:right;font-weight:600">${value}</td></tr>`).join("")}
      </table>
      ${markdownToHtml(aiReport.markdown)}
      <p style="margin-top:24px;color:#7f8c8d;font-size:12px">数据来自 Garmin/Intervals.icu；AI 只基于结构化指标生成建议，缺失字段不会被推测。</p>
    </main>`;
  const text = [`骑行分析｜${activity.date}`, "", livelySummary.text, "", "关键指标：", ...metrics.map(([label, value]) => `- ${label}: ${stripHtml(value)}`), "", stripMarkdown(aiReport.markdown)].join("\n");

  return { subject, html, text };
}

async function intervalsFetch(env, path) {
  const res = await fetch(`${INTERVALS_BASE_URL}${path}`, {
    headers: {
      Authorization: `Basic ${btoa(`API_KEY:${env.INTERVALS_API_KEY}`)}`,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Intervals.icu ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function safeIntervalsFetch(env, path) {
  try {
    return await intervalsFetch(env, path);
  } catch (_error) {
    return null;
  }
}

async function fetchWellnessRange(env, athleteId, oldest, newest) {
  const data = await safeIntervalsFetch(env, `/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${newest}`);
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

async function sendEmail(env, subject, html, text) {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [env.RECIPIENT_EMAIL],
      subject,
      html,
      text
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function isCyclingActivity(activity) {
  const type = String(activity.type || activity.sport || activity.icu_sport || "").toLowerCase();
  return ["ride", "virtualride", "cycling", "biking", "mountainbike", "gravelride"].some((item) => type.includes(item));
}

function getActivityId(activity) {
  return activity.id || activity.icu_id || activity.file_id;
}

function byNewestActivity(a, b) {
  return new Date(b.start_date_local || b.start_date || 0) - new Date(a.start_date_local || a.start_date || 0);
}

function activityDate(activity) {
  return localDate(activity.start_date_local || activity.start_date || activity.date || new Date().toISOString());
}

function inDateRange(value, oldest, newest) {
  return value >= oldest && value <= newest;
}

function dateRange(daysBack, daysForward) {
  const now = new Date();
  const oldest = new Date(now);
  oldest.setUTCDate(now.getUTCDate() - daysBack);
  const newest = new Date(now);
  newest.setUTCDate(now.getUTCDate() + daysForward);
  return { oldest: isoDate(oldest), newest: isoDate(newest) };
}

function powerPeaks(activity) {
  return {
    p15s: positiveNumber(activity.power_15s, activity.best_15s, activity.watts_15s, findByKeyHint(activity, ["15", "power"])),
    p5s: positiveNumber(activity.power_5s, activity.best_5s, activity.watts_5s, findByKeyHint(activity, ["5", "power"])),
    p1m: positiveNumber(activity.power_60s, activity.best_60s, activity.watts_60s, findByKeyHint(activity, ["60", "power"])),
    p5m: positiveNumber(activity.power_300s, activity.best_300s, activity.watts_300s, findByKeyHint(activity, ["300", "power"])),
    p20m: positiveNumber(activity.power_1200s, activity.best_1200s, activity.watts_1200s, findByKeyHint(activity, ["1200", "power"])),
    p1h: positiveNumber(activity.power_3600s, activity.best_3600s, activity.watts_3600s, findByKeyHint(activity, ["3600", "power"]))
  };
}

function zoneHints(activity) {
  const keys = Object.keys(activity).filter((key) => /zone|z[1-7]|power.*time|hr.*time/i.test(key));
  return keys.slice(0, 20).reduce((acc, key) => {
    if (typeof activity[key] !== "object") acc[key] = activity[key];
    return acc;
  }, {});
}

function fieldHints(activity) {
  const hints = ["balance", "left", "right", "cadence", "ftp", "eftp", "form", "fitness", "fatigue"];
  return Object.keys(activity)
    .filter((key) => hints.some((hint) => key.toLowerCase().includes(hint)))
    .slice(0, 30)
    .reduce((acc, key) => {
      if (typeof activity[key] !== "object") acc[key] = activity[key];
      return acc;
    }, {});
}

function findByKeyHint(object, hints) {
  const key = Object.keys(object || {}).find((candidate) => hints.every((hint) => candidate.toLowerCase().includes(String(hint).toLowerCase())));
  return key ? object[key] : null;
}

function nutritionAdvice(activity) {
  const advice = [];
  if (activity.movingTimeSec >= 5400 || activity.load >= 90) {
    advice.push("骑后 2 小时内补充碳水 1.0-1.2 g/kg，并搭配 20-40 g 蛋白质。");
    advice.push("出汗明显时补充电解质和 500-1000 ml 水，后续按体重变化和尿液颜色调整。");
  } else if (activity.intensity >= 0.8) {
    advice.push("强度不低，骑后补一餐含碳水和蛋白的正餐，避免空腹拖太久。");
  } else {
    advice.push("正常饮食即可，注意补水；如果明天有强度课，晚餐保证碳水。");
  }
  return advice;
}

function trainingStatusLine(recovery, history, wellness) {
  if (recovery.level === "high") return { icon: "🟠", text: "恢复压力偏高，今天这笔训练刺激值得保留，接下来别急着加码" };
  if (history.load7d >= 450) return { icon: "🟡", text: "近期训练负荷充实，适合稳住节奏，避免连续堆强度" };
  if (wellness.hrvDeltaPct != null && wellness.hrvDeltaPct > 10) return { icon: "🟢", text: "恢复信号不错，可以按计划推进训练" };
  return { icon: "🟢", text: "状态平稳，训练安排可以保持连续性" };
}

function estimateRecoveryHours(activity, recovery, wellness) {
  let hours = 10;
  if (activity.load >= 150) hours += 18;
  else if (activity.load >= 100) hours += 12;
  else if (activity.load >= 60) hours += 6;
  if (activity.intensity >= 0.85) hours += 8;
  if (activity.decouplingPct != null && activity.decouplingPct > 7) hours += 4;
  if (wellness.restingHrDelta != null && wellness.restingHrDelta >= 5) hours += 4;
  if (recovery.level === "high") hours += 4;
  return Math.min(48, Math.max(8, Math.round(hours)));
}

function peakPowerLines(activity) {
  const peaks = [
    ["15秒", activity.powerPeaks?.p15s],
    ["1分", activity.powerPeaks?.p1m],
    ["5分", activity.powerPeaks?.p5m],
    ["20分", activity.powerPeaks?.p20m],
    ["1小时", activity.powerPeaks?.p1h]
  ].filter(([, value]) => value);
  if (!peaks.length) {
    const ftpEffort = activity.rawFieldHints?.icu_pm_ftp_watts && activity.rawFieldHints?.icu_pm_ftp_secs
      ? `⚡ 近似最佳 ${format(activity.rawFieldHints.icu_pm_ftp_secs / 60, 0)}分 ${format(activity.rawFieldHints.icu_pm_ftp_watts, 0)}W`
      : "⚡ 峰值功率暂缺，Intervals.icu API 没有返回 15秒/1分/5分/20分字段";
    return [ftpEffort, "💡 后续可以适配活动流数据，做更完整的峰值功率榜"];
  }
  return peaks.map(([label, value]) => `⚡ ${label} ${format(value, 0)}W`);
}

function compactZoneLines(zoneHintsValue) {
  const zoneHintsObject = zoneHintsValue || {};
  const entries = Object.entries(zoneHintsObject)
    .filter(([key, value]) => /z[1-7]|zone/i.test(key) && Number.isFinite(Number(value)))
    .slice(0, 8);
  if (!entries.length) return ["🌈 功率区/心率区分布暂缺，当前邮件先展示核心训练负荷和强度"];
  return entries.map(([key, value]) => `🌈 ${key}: ${format(value, 1)}`);
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function markdownToHtml(markdown) {
  const lines = escapeHtml(markdown).split(/\r?\n/);
  const html = [];
  let inList = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h3>${line.slice(3)}</h3>`);
    } else if (line.startsWith("- ")) {
      if (!inList) html.push("<ul>");
      inList = true;
      html.push(`<li>${line.slice(2)}</li>`);
    } else if (line.trim()) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<p>${line}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

function stripMarkdown(markdown) {
  return markdown.replace(/^##\s+/gm, "").replace(/^\-\s+/gm, "- ");
}

function boolParam(url, name) {
  return ["1", "true", "yes"].includes(String(url.searchParams.get(name) || "").toLowerCase());
}

function intParam(url, name, fallback) {
  const value = Number(url.searchParams.get(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function localDate(value) {
  return String(value).slice(0, 10);
}

function daysBetween(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00Z`);
  const b = new Date(`${dateB}T00:00:00Z`);
  return Math.abs((b - a) / (24 * 60 * 60 * 1000));
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function rangeNumber(min, max, ...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= min && number <= max) return number;
  }
  return null;
}

function isNumber(value) {
  return Number.isFinite(Number(value));
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value), 0);
}

function average(values) {
  return values.length ? sum(values) / values.length : null;
}

function km(value) {
  if (value == null) return null;
  return value > 1000 ? value / 1000 : value;
}

function seconds(value) {
  return value == null ? null : value;
}

function normalizeIntensity(value) {
  if (value == null) return null;
  return value > 2 ? value / 100 : value;
}

function normalizePercent(value) {
  if (value == null) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function format(value, digits) {
  if (value == null || !Number.isFinite(Number(value))) return "暂无";
  return Number(value).toFixed(digits);
}

function watts(value) {
  return value == null ? "暂无" : `${format(value, 0)} W`;
}

function hrPair(avgHr, maxHr) {
  if (avgHr == null && maxHr == null) return "暂无";
  return `${avgHr == null ? "暂无" : format(avgHr, 0)} / ${maxHr == null ? "暂无" : format(maxHr, 0)} bpm`;
}

function formatDuration(value) {
  if (value == null) return "暂无";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, "");
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
