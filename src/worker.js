const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";
const OURA_BASE_URL = "https://api.ouraring.com/v2/usercollection";
const RESEND_URL = "https://api.resend.com/emails";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CHINA_TIME_ZONE = "Asia/Shanghai";

const CRON_RIDE = "*/30 * * * *";
const CRON_BODY_MORNING = "20 1 * * *";
const CRON_BODY_EVENING = "0 13 * * *";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return health(env);

    if (url.pathname === "/run" || url.pathname === "/run/ride") {
      return json(await runRideAnalysis(env, rideOptions(url)));
    }

    if (url.pathname === "/run/body/morning") {
      return json(await runBodyReport(env, "morning", bodyOptions(url)));
    }

    if (url.pathname === "/run/body/evening") {
      return json(await runBodyReport(env, "evening", bodyOptions(url)));
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    if (controller.cron === CRON_BODY_MORNING) {
      ctx.waitUntil(runBodyReport(env, "morning", { force: false, dryRun: false }));
      return;
    }
    if (controller.cron === CRON_BODY_EVENING) {
      ctx.waitUntil(runBodyReport(env, "evening", { force: false, dryRun: false }));
      return;
    }
    ctx.waitUntil(runRideAnalysis(env, { force: false, dryRun: false, maxRides: 6 }));
  }
};

function health(env) {
  return json({
    ok: true,
    service: "garmin-intervals-mailer",
    modules: {
      rideAnalysis: true,
      bodyStatus: true
    },
    ai: Boolean(env.OPENAI_API_KEY),
    bindings: {
      intervals: "INTERVALS_API_KEY" in env,
      oura: "OURA_ACCESS_TOKEN" in env,
      resend: "RESEND_API_KEY" in env,
      openai: "OPENAI_API_KEY" in env,
      openaiModel: env.OPENAI_MODEL || null
    },
    schedules: {
      ride: CRON_RIDE,
      bodyMorning: CRON_BODY_MORNING,
      bodyEvening: CRON_BODY_EVENING,
      timeZone: CHINA_TIME_ZONE
    }
  });
}

async function runRideAnalysis(env, options = {}) {
  requireEnv(env, ["INTERVALS_API_KEY", "RESEND_API_KEY", "RECIPIENT_EMAIL", "RESEND_FROM"]);

  const athleteId = env.INTERVALS_ATHLETE_ID || "0";
  const processRange = utcDateRangeAround(new Date(), 3, 1);
  const historyRange = utcDateRangeAround(new Date(), 56, 1);
  const activities = await fetchActivities(env, athleteId, historyRange.oldest, historyRange.newest);
  const rides = activities.filter(isCyclingActivity).sort(byNewestActivity);
  const wellnessDays = await fetchWellnessRange(env, athleteId, historyRange.oldest, historyRange.newest);
  const processable = rides
    .filter((activity) => inDateRange(activityDate(activity), processRange.oldest, processRange.newest))
    .slice(0, options.maxRides || 6);

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
    const analysis = buildRideAnalysis(activityData, rides, wellnessDays);
    const aiReport = await buildAiReport(env, "ride", analysis, buildRuleRideReport(analysis));
    const report = buildRideEmailReport(analysis, aiReport);

    if (options.dryRun) {
      previews.push({ id: activityId, subject: report.subject, analysis, aiReport });
      continue;
    }

    await sendEmail(env, report.subject, report.html, report.text);
    await env.SENT_ACTIVITIES.put(kvKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 180 });
    sent.push({ id: activityId, name: analysis.activity.name, subject: report.subject, ai: aiReport.source });
  }

  return { ok: true, module: "ride", sent, skipped, previews, checked: processable.length, aiEnabled: Boolean(env.OPENAI_API_KEY) };
}

async function runBodyReport(env, kind, options = {}) {
  requireEnv(env, ["INTERVALS_API_KEY", "RESEND_API_KEY", "RECIPIENT_EMAIL", "RESEND_FROM"]);

  const athleteId = env.INTERVALS_ATHLETE_ID || "0";
  const reportDate = options.date || chinaDate();
  const kvKey = `sent:body:${kind}:${reportDate}`;
  const alreadySent = await env.SENT_ACTIVITIES.get(kvKey);

  if (alreadySent && !options.force) {
    return { ok: true, module: "body", kind, date: reportDate, sent: [], skipped: [{ reason: "already-sent", key: kvKey }], previews: [], aiEnabled: Boolean(env.OPENAI_API_KEY) };
  }

  const range = dateRangeFromIso(reportDate, 14, 1);
  const dayRange = dateRangeFromIso(reportDate, 0, 0);
  const [wellnessDays, activities] = await Promise.all([
    fetchWellnessRange(env, athleteId, range.oldest, range.newest),
    fetchActivities(env, athleteId, dayRange.oldest, dayRange.newest)
  ]);

  const ouraData = await fetchOuraDailyData(env, range.oldest, range.newest);
  const analysis = buildBodyAnalysis(kind, reportDate, wellnessDays, activities, ouraData);
  const fallback = buildRuleBodyReport(analysis);
  const aiReport = await buildAiReport(env, `body-${kind}`, analysis, fallback);
  const report = buildBodyEmailReport(analysis, aiReport);

  if (options.dryRun) {
    return { ok: true, module: "body", kind, date: reportDate, sent: [], skipped: [], previews: [{ subject: report.subject, analysis, aiReport }], aiEnabled: Boolean(env.OPENAI_API_KEY) };
  }

  await sendEmail(env, report.subject, report.html, report.text);
  await env.SENT_ACTIVITIES.put(kvKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 180 });
  return { ok: true, module: "body", kind, date: reportDate, sent: [{ key: kvKey, subject: report.subject, ai: aiReport.source }], skipped: [], previews: [], aiEnabled: Boolean(env.OPENAI_API_KEY) };
}

function buildRideAnalysis(activity, historyRides, wellnessDays) {
  const activitySummary = summarizeActivity(activity);
  const history = summarizeHistory(historyRides, activitySummary.date);
  const wellness = summarizeWellness(wellnessDays, activitySummary.date);
  const structure = inferRideStructure(activitySummary);
  const recovery = inferRecovery(activitySummary, history, wellness);
  const dataQuality = inferRideDataQuality(activitySummary);

  return {
    type: "ride-analysis",
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

function buildBodyAnalysis(kind, date, wellnessDays, activities, ouraData = null) {
  const wellness = summarizeWellness(wellnessDays, date, ouraData);
  const dayActivities = activities.filter((activity) => activityDate(activity) === date);
  const activitySummary = summarizeDailyActivities(dayActivities);
  const status = inferBodyStatus(kind, wellness, activitySummary);
  const readiness = bodyReadinessAdvice(kind, status, wellness, activitySummary);
  const dataQuality = inferBodyDataQuality(wellness, activitySummary);

  return {
    type: "body-status",
    kind,
    date,
    generatedAt: new Date().toISOString(),
    wellness,
    activity: activitySummary,
    status,
    readiness,
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
  const avgHr = firstNumber(activity.average_heartrate, activity.avg_hr, activity.icu_average_heartrate);
  const maxHr = firstNumber(activity.max_heartrate, activity.max_hr);

  return {
    id: getActivityId(activity),
    name: activity.name || "骑行",
    date,
    type: activity.type || activity.sport || activity.icu_sport || "ride",
    distanceKm,
    movingTimeSec: movingTime,
    movingTimeText: formatDuration(movingTime),
    elevationM: firstNumber(activity.total_elevation_gain, activity.elevation_gain, activity.icu_elevation),
    avgPowerW: avgPower,
    weightedPowerW: weightedPower,
    maxPowerW: firstNumber(activity.max_watts, activity.max_power),
    avgHr,
    maxHr,
    avgCadence: firstNumber(activity.average_cadence, activity.avg_cadence, activity.icu_average_cadence),
    load,
    intensity,
    calories: firstNumber(activity.calories, activity.kcal),
    kilojoules: firstNumber(activity.kilojoules, activity.work),
    decouplingPct: normalizePercent(firstNumber(activity.decoupling, activity.power_hr_decoupling, activity.aerobic_decoupling, activity.icu_decoupling)),
    ftpW: firstNumber(activity.ftp, activity.icu_ftp, activity.athlete_ftp),
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
  const loads7 = last7.map(activityLoad).filter(isNumber);
  const loads28 = last28.map(activityLoad).filter(isNumber);
  const intensities28 = last28.map(activityIntensity).filter(isNumber);

  return {
    rides7d: last7.length,
    rides28d: last28.length,
    load7d: sum(loads7),
    load28d: sum(loads28),
    avgLoad28d: average(loads28),
    avgIntensity28d: average(intensities28),
    loadRamp: loads28.length ? sum(loads7) - sum(loads28) / 4 : null,
    recentHighLoadCount: last28.filter((ride) => activityLoad(ride) >= 100).length,
    recentRides: last42.slice(0, 8).map((ride) => ({
      date: activityDate(ride),
      name: ride.name || "骑行",
      distanceKm: km(firstNumber(ride.distance, ride.icu_distance)),
      load: activityLoad(ride),
      intensity: activityIntensity(ride)
    }))
  };
}

function summarizeWellness(wellnessDays, activityDateValue, ouraData = null) {
  const dated = (Array.isArray(wellnessDays) ? wellnessDays : [])
    .map((item) => ({ ...item, date: localDate(item.id || item.date || item.day || item.start_date || "") }))
    .filter((item) => item.date);
  const current = dated.find((item) => item.date === activityDateValue) || null;
  const last7 = dated.filter((item) => daysBetween(item.date, activityDateValue) <= 7);
  const oura = summarizeOuraWellness(ouraData, activityDateValue);
  const hrvToday = positiveNumber(oura.hrvToday, current?.hrv, current?.hrvRMSSD, current?.hrv_rmssd);
  const restingHrToday = rangeNumber(25, 120, oura.restingHrToday, current?.restingHR, current?.resting_hr, current?.restingHeartRate);
  const sleepSecToday = rangeNumber(60 * 60, 14 * 60 * 60, oura.sleepTodaySec, current?.sleepSecs, current?.sleep_seconds, current?.sleep);
  const hrv7 = average(last7.map((item) => positiveNumber(item.hrv, item.hrvRMSSD, item.hrv_rmssd)).filter(isNumber));
  const restingHr7 = average(last7.map((item) => rangeNumber(25, 120, item.restingHR, item.resting_hr, item.restingHeartRate)).filter(isNumber));
  const sleep7 = average(last7.map((item) => rangeNumber(60 * 60, 14 * 60 * 60, item.sleepSecs, item.sleep_seconds, item.sleep)).filter(isNumber));

  return {
    available: Boolean(oura.available || current || last7.length),
    source: oura.available ? "oura-api+intervals" : "intervals",
    date: activityDateValue,
    hrvToday,
    hrv7dAvg: oura.hrv7dAvg ?? hrv7,
    hrvDeltaPct: hrvToday && (oura.hrv7dAvg ?? hrv7) ? ((hrvToday - (oura.hrv7dAvg ?? hrv7)) / (oura.hrv7dAvg ?? hrv7)) * 100 : null,
    restingHrToday,
    restingHr7dAvg: oura.restingHr7dAvg ?? restingHr7,
    restingHrDelta: restingHrToday && (oura.restingHr7dAvg ?? restingHr7) ? restingHrToday - (oura.restingHr7dAvg ?? restingHr7) : null,
    sleepTodaySec: sleepSecToday,
    sleep7dAvgSec: oura.sleep7dAvgSec ?? sleep7,
    sleepDebtSec: sleepSecToday && (oura.sleep7dAvgSec ?? sleep7) ? sleepSecToday - (oura.sleep7dAvgSec ?? sleep7) : null,
    sleepScore: firstNumber(oura.sleepScore, current?.sleepScore, current?.sleep_score, current?.oura_sleep_score),
    sleepQuality: firstNumber(oura.sleepQuality, current?.sleepQuality, current?.sleep_quality),
    sleepEfficiency: firstNumber(oura.sleepEfficiency),
    remSleepSec: firstNumber(oura.remSleepSec),
    deepSleepSec: firstNumber(oura.deepSleepSec),
    awakeSec: firstNumber(oura.awakeSec),
    sleepLatencySec: firstNumber(oura.sleepLatencySec),
    bedtimeStart: oura.bedtimeStart,
    bedtimeEnd: oura.bedtimeEnd,
    avgSleepingHr: rangeNumber(25, 120, oura.avgSleepingHr, current?.avgSleepingHR, current?.avg_sleeping_hr, current?.average_sleeping_hr),
    lowestSleepingHr: rangeNumber(25, 120, oura.lowestSleepingHr),
    readiness: firstNumber(oura.readiness, current?.readiness, current?.readiness_score, current?.oura_readiness),
    readinessContributors: oura.readinessContributors,
    temperatureDeviation: firstNumber(oura.temperatureDeviation),
    respiratoryRate: firstNumber(oura.respiratoryRate),
    stress: positiveNumber(oura.stress, current?.stress, current?.stress_score, current?.avg_stress),
    stressSummary: oura.stressSummary,
    stressHighSec: firstNumber(oura.stressHighSec),
    stressRecoverySec: firstNumber(oura.stressRecoverySec),
    bodyBattery: firstNumber(current?.bodyBattery, current?.body_battery, current?.bodyBatteryCharged),
    steps: firstNumber(oura.steps, current?.steps, current?.step_count),
    activeCalories: firstNumber(oura.activeCalories, current?.activeCalories, current?.active_calories),
    totalCalories: firstNumber(oura.totalCalories),
    activityScore: firstNumber(oura.activityScore),
    sedentaryTimeSec: firstNumber(oura.sedentaryTimeSec),
    lowActivityTimeSec: firstNumber(oura.lowActivityTimeSec),
    mediumActivityTimeSec: firstNumber(oura.mediumActivityTimeSec),
    highActivityTimeSec: firstNumber(oura.highActivityTimeSec),
    dataSources: {
      oura: oura.available,
      intervals: Boolean(current || last7.length)
    },
    rawHints: {
      intervals: current ? wellnessHints(current) : {},
      oura: oura.rawHints || {}
    },
    ouraErrors: ouraData?.errors || []
  };
}

function summarizeOuraWellness(ouraData, activityDateValue) {
  if (!ouraData?.enabled) return { available: false };
  const dailySleep = matchOuraDay(ouraData.dailySleep, activityDateValue);
  const dailyReadiness = matchOuraDay(ouraData.dailyReadiness, activityDateValue);
  const dailyActivity = matchOuraDay(ouraData.dailyActivity, activityDateValue);
  const dailyStress = matchOuraDay(ouraData.dailyStress, activityDateValue);
  const sleepSession = matchOuraMainSleep(ouraData.sleepSessions, activityDateValue);
  const recentSleepSessions = recentOuraMainSleeps(ouraData.sleepSessions, activityDateValue, 7);
  const recentDailySleep = recentOuraDays(ouraData.dailySleep, activityDateValue, 7);

  const sleepDurations = recentSleepSessions
    .map((item) => rangeNumber(60 * 60, 14 * 60 * 60, item.total_sleep_duration, item.total_sleep_duration_seconds))
    .filter(isNumber);
  const hrvValues = recentSleepSessions
    .map((item) => positiveNumber(item.average_hrv, item.avg_hrv, item.hrv))
    .filter(isNumber);
  const restingHrValues = recentSleepSessions
    .map((item) => rangeNumber(25, 120, item.lowest_heart_rate, item.average_heart_rate))
    .filter(isNumber);

  return {
    available: Boolean(dailySleep || dailyReadiness || dailyActivity || dailyStress || sleepSession),
    sleepTodaySec: rangeNumber(60 * 60, 14 * 60 * 60, sleepSession?.total_sleep_duration, sleepSession?.total_sleep_duration_seconds),
    sleep7dAvgSec: average(sleepDurations),
    sleepScore: firstNumber(dailySleep?.score, sleepSession?.score),
    sleepQuality: firstNumber(dailySleep?.score, sleepSession?.score),
    sleepEfficiency: firstNumber(sleepSession?.efficiency),
    remSleepSec: firstNumber(sleepSession?.rem_sleep_duration),
    deepSleepSec: firstNumber(sleepSession?.deep_sleep_duration),
    awakeSec: firstNumber(sleepSession?.awake_time),
    sleepLatencySec: firstNumber(sleepSession?.latency),
    bedtimeStart: sleepSession?.bedtime_start || null,
    bedtimeEnd: sleepSession?.bedtime_end || null,
    hrvToday: positiveNumber(sleepSession?.average_hrv, sleepSession?.avg_hrv, sleepSession?.hrv),
    hrv7dAvg: average(hrvValues),
    restingHrToday: rangeNumber(25, 120, sleepSession?.lowest_heart_rate, sleepSession?.average_heart_rate),
    restingHr7dAvg: average(restingHrValues),
    avgSleepingHr: rangeNumber(25, 120, sleepSession?.average_heart_rate),
    lowestSleepingHr: rangeNumber(25, 120, sleepSession?.lowest_heart_rate),
    readiness: firstNumber(dailyReadiness?.score),
    readinessContributors: dailyReadiness?.contributors || null,
    temperatureDeviation: firstNumber(sleepSession?.temperature_deviation, dailyReadiness?.temperature_deviation),
    respiratoryRate: firstNumber(sleepSession?.average_breath, sleepSession?.respiratory_rate),
    stress: positiveNumber(dailyStress?.stress_high),
    stressSummary: dailyStress?.day_summary || null,
    stressHighSec: firstNumber(dailyStress?.stress_high),
    stressRecoverySec: firstNumber(dailyStress?.recovery_high),
    steps: firstNumber(dailyActivity?.steps),
    activeCalories: firstNumber(dailyActivity?.active_calories),
    totalCalories: firstNumber(dailyActivity?.total_calories),
    activityScore: firstNumber(dailyActivity?.score),
    sedentaryTimeSec: firstNumber(dailyActivity?.sedentary_time),
    lowActivityTimeSec: firstNumber(dailyActivity?.low_activity_time),
    mediumActivityTimeSec: firstNumber(dailyActivity?.medium_activity_time),
    highActivityTimeSec: firstNumber(dailyActivity?.high_activity_time),
    rawHints: {
      dailySleep: compactObject(dailySleep, ["id", "day", "score", "contributors"]),
      dailyReadiness: compactObject(dailyReadiness, ["id", "day", "score", "contributors"]),
      dailyActivity: compactObject(dailyActivity, ["id", "day", "score", "steps", "active_calories", "total_calories", "sedentary_time"]),
      dailyStress: compactObject(dailyStress, ["id", "day", "stress_high", "stress_medium", "recovery_high", "day_summary"]),
      sleep: compactObject(sleepSession, ["id", "day", "score", "total_sleep_duration", "efficiency", "average_heart_rate", "lowest_heart_rate", "average_hrv", "temperature_deviation", "average_breath"])
    }
  };
}

function summarizeDailyActivities(activities) {
  const summaries = activities.map((activity) => ({
    id: getActivityId(activity),
    name: activity.name || activity.type || "活动",
    type: activity.type || activity.sport || activity.icu_sport || "activity",
    durationSec: seconds(firstNumber(activity.moving_time, activity.elapsed_time, activity.duration)),
    distanceKm: km(firstNumber(activity.distance, activity.icu_distance)),
    load: activityLoad(activity),
    intensity: activityIntensity(activity),
    calories: firstNumber(activity.calories, activity.kcal),
    avgHr: firstNumber(activity.average_heartrate, activity.avg_hr, activity.icu_average_heartrate)
  }));
  const loads = summaries.map((item) => item.load).filter(isNumber);
  const intensities = summaries.map((item) => item.intensity).filter(isNumber);

  return {
    count: summaries.length,
    totalDurationSec: sum(summaries.map((item) => item.durationSec).filter(isNumber)),
    totalDistanceKm: sum(summaries.map((item) => item.distanceKm).filter(isNumber)),
    totalLoad: sum(loads),
    maxIntensity: intensities.length ? Math.max(...intensities) : null,
    totalCalories: sum(summaries.map((item) => item.calories).filter(isNumber)),
    activities: summaries
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
    purpose = "明显推动强度适应，适合作为重点训练日";
  } else if (load >= 130 && intensity < 0.75) {
    label = "长距离高负荷耐力骑";
    purpose = "以时间和爬升累积训练压力，主要刺激耐力和抗疲劳能力";
  } else if (load >= 130) {
    label = "高负荷质量训练";
    purpose = "训练负荷较高，对疲劳和适应都有明显推动";
  } else if (intensity >= 0.84) {
    label = "阈值/甜区训练";
    purpose = "提升持续输出能力和阈值附近耐受";
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

function inferBodyStatus(kind, wellness, activity) {
  let score = 0;
  const reasons = [];

  if (!wellness.available) {
    reasons.push("当天 wellness 数据未同步完整。");
  }
  if (wellness.sleepTodaySec != null && wellness.sleepTodaySec < 6 * 60 * 60) {
    score -= 2;
    reasons.push("睡眠时长不足 6 小时。");
  }
  if (wellness.hrvDeltaPct != null && wellness.hrvDeltaPct < -12) {
    score -= 2;
    reasons.push("HRV 明显低于近 7 日均值。");
  } else if (wellness.hrvDeltaPct != null && wellness.hrvDeltaPct > 10) {
    score += 1;
    reasons.push("HRV 高于近 7 日均值，恢复信号不错。");
  }
  if (wellness.restingHrDelta != null && wellness.restingHrDelta >= 5) {
    score -= 2;
    reasons.push("静息心率高于近 7 日均值。");
  }
  if (activity.totalLoad >= 120) {
    score -= kind === "evening" ? 2 : 1;
    reasons.push("当天训练负荷较高。");
  }
  if (activity.totalLoad >= 60 && activity.totalLoad < 120) {
    score -= 1;
    reasons.push("当天存在中等训练刺激。");
  }

  if (score <= -3) return { label: "优先恢复", icon: "🟠", score, reasons };
  if (score <= -1) return { label: "保守推进", icon: "🟡", score, reasons };
  return { label: "可训练", icon: "🟢", score, reasons: reasons.length ? reasons : ["关键恢复指标整体平稳。"] };
}

function bodyReadinessAdvice(kind, status, wellness, activity) {
  const morning = kind === "morning";
  const training = [];
  const recovery = [];
  const sleep = [];

  if (status.label === "优先恢复") {
    training.push(morning ? "今天不安排高强度训练，最多做轻松有氧或活动恢复。" : "明天优先恢复，若训练也只做 Z1-Z2。");
  } else if (status.label === "保守推进") {
    training.push(morning ? "今天可以训练，但建议把强度上限控制在有氧/节奏以下。" : "明天可以按计划推进，但先用热身状态决定是否加强度。");
  } else {
    training.push(morning ? "今天身体信号允许正常训练，仍建议用热身心率确认状态。" : "明天可以按计划训练，注意别连续堆叠高负荷。");
  }

  if (wellness.sleepTodaySec != null && wellness.sleepTodaySec < 6.5 * 60 * 60) {
    recovery.push("白天安排 15-25 分钟短午休，避免傍晚后摄入咖啡因。");
  } else {
    recovery.push("保持补水和规律进食，午后避免额外压力堆叠。");
  }
  if (activity.totalLoad >= 80) {
    recovery.push("训练后补充碳水和 20-40g 蛋白质，晚餐不要过度压缩碳水。");
  }
  sleep.push(morning ? "今晚优先保证固定入睡时间。" : "睡前 60 分钟降低屏幕和工作刺激，给 HRV 一个更好的恢复窗口。");

  return { training, recovery, sleep };
}

function inferRideDataQuality(activity) {
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

function inferBodyDataQuality(wellness, activity) {
  const missing = [];
  if (wellness.sleepTodaySec == null) missing.push("睡眠");
  if (wellness.sleepScore == null) missing.push("睡眠评分");
  if (wellness.hrvToday == null) missing.push("HRV");
  if (wellness.restingHrToday == null) missing.push("静息心率");
  if (wellness.stress == null) missing.push("压力");

  return {
    completeness: missing.length <= 1 ? "good" : missing.length <= 3 ? "partial" : "poor",
    missing,
    note: missing.length ? `未同步/暂缺：${missing.join("、")}。本邮件只基于已同步字段分析。` : "身体状态关键字段完整。"
  };
}

async function buildAiReport(env, kind, analysis, fallback) {
  if (!env.OPENAI_API_KEY) return { source: "rules", markdown: fallback };

  try {
    const prompt = aiPrompt(kind, analysis);
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4.1-mini",
        max_output_tokens: 1600,
        instructions: prompt.instructions,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt.text }] }]
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

function aiPrompt(kind, analysis) {
  if (kind === "body-morning") {
    return {
      instructions: "你是一名严谨但表达有活力的身体状态分析师。只基于用户提供的 JSON 数据分析，不要编造缺失指标。输出中文，像私人健康教练，专业、轻快、具体，但不过度医疗化。",
      text: [
        "请写一封晨间身体状态分析邮件正文。邮件前面已有图标化摘要，所以正文不要重复堆指标，要把 Oura 恢复数据和 Intervals.icu/Garmin 训练负荷整合成今天的行动建议。",
        "定位：不要复刻 Oura App，也不要只复述睡眠评分；你的价值是判断今天该怎么练、怎么恢复，以及恢复信号和近期训练负荷是否冲突。",
        "要求：1. 一句总评；2. 解释 Oura 睡眠/HRV/静息心率/准备度对今天的含义；3. 结合当天/近期训练负荷给出今日训练强度上限；4. 补水、咖啡因、午休建议；5. 缺失字段要明确说明；6. 不要说自己是 AI。",
        "",
        JSON.stringify(analysis, null, 2)
      ].join("\n")
    };
  }
  if (kind === "body-evening") {
    return {
      instructions: "你是一名严谨但表达有活力的晚间身体状态分析师。只基于用户提供的 JSON 数据分析，不要编造缺失指标。输出中文，像私人健康教练，专业、轻快、具体，但不过度医疗化。",
      text: [
        "请写一封晚间身体小报正文。邮件前面已有图标化摘要，所以正文要把今天身体承受了什么、今晚怎么睡、明天怎么安排讲清楚。",
        "定位：不要复刻 Oura App；你的价值是把 Oura 的全天恢复/活动信号与 Intervals.icu/Garmin 的运动负荷放在一起，形成明天的训练和恢复决策。",
        "要求：1. 一句总评；2. 当天活动/运动负荷解读，如果 activity.count 为 0，要按日常活动与恢复日分析，不要写成空白或异常；3. 说明 Oura 恢复信号和训练负荷是否一致，若冲突要给出保守建议；4. 睡前建议；5. 明天训练建议；6. 缺失字段要明确说明；7. 不要说自己是 AI。",
        "",
        JSON.stringify(analysis, null, 2)
      ].join("\n")
    };
  }
  return {
    instructions: "你是一名严谨但表达有活力的自行车训练分析师。只基于用户提供的 JSON 数据分析，不要编造缺失指标。输出中文，结构清晰，给出具体但不过度医疗化的训练和恢复建议。语气可以像私人教练，专业、轻快、有一点鼓励感。",
    text: [
      "请为下面这次骑行写一份专业训练分析邮件正文。邮件前面已经有一块图标化活动快照，所以正文不要重复堆指标，要把指标翻译成训练含义。",
      "要求：1. 一句有画面感的总评；2. 判断训练目的和效果；3. 分析功率、心率、训练负荷、Power/HR 漂移、近期负荷和健康状态；4. 给出明天训练、恢复、补给建议；5. 指出数据缺口；6. 不要说自己是 AI。",
      "",
      JSON.stringify(analysis, null, 2)
    ].join("\n")
  };
}

function buildRuleRideReport(analysis) {
  const { activity, structure, history, wellness, recovery, dataQuality } = analysis;
  return [
    "## 总评",
    `这次是一次${structure.label}，主要目的偏向${structure.purpose}。训练负荷为 ${format(activity.load, 0)}，强度系数为 ${format(activity.intensity, 2)}，整体恢复压力为 ${recovery.level}。`,
    "",
    "## 训练解读",
    `距离 ${format(activity.distanceKm, 1)} km，移动时间 ${activity.movingTimeText}，加权功率 ${watts(activity.weightedPowerW)}，平均心率 ${format(activity.avgHr, 0)} bpm。`,
    ...structure.notes.map((note) => `- ${note}`),
    `近 7 天训练负荷约 ${format(history.load7d, 0)}，近 28 天训练负荷约 ${format(history.load28d, 0)}。`,
    "",
    "## 明天建议",
    ...recovery.nextDay.map((item) => `- ${item}`),
    `- ${recovery.sleep}`,
    ...recovery.nutrition.map((item) => `- ${item}`),
    "",
    "## 数据质量",
    `- ${dataQuality.note}`,
    wellness.available ? `- HRV 今日 ${format(wellness.hrvToday, 0)} ms，静息心率 ${format(wellness.restingHrToday, 0)} bpm，睡眠 ${formatDuration(wellness.sleepTodaySec)}。` : "- 未读取到当天 Garmin/Oura 健康数据。"
  ].join("\n");
}

function buildRuleBodyReport(analysis) {
  const { kind, wellness, activity, status, readiness, dataQuality } = analysis;
  const title = kind === "morning" ? "今日身体状态" : "晚间小报";
  const activityLine = activity.count
    ? `今天有 ${activity.count} 项训练/活动，总负荷 ${format(activity.totalLoad, 0)}，运动时长 ${formatDuration(activity.totalDurationSec)}。`
    : `今天没有训练记录，按日常恢复日处理：步数 ${format(wellness.steps, 0)} 步，睡眠评分 ${format(wellness.sleepScore, 0)}，准备度 ${format(wellness.readiness, 0)}。`;
  return [
    `## ${title}`,
    `${status.icon} ${status.label}。${status.reasons.join(" ")}`,
    "",
    "## 关键解读",
    `睡眠 ${formatDuration(wellness.sleepTodaySec)}，睡眠评分 ${format(wellness.sleepScore, 0)}，睡眠均心率 ${format(wellness.avgSleepingHr, 0)} bpm。`,
    `HRV ${format(wellness.hrvToday, 0)} ms，静息心率 ${format(wellness.restingHrToday, 0)} bpm，Oura 准备度 ${format(wellness.readiness, 0)}。`,
    activityLine,
    "",
    "## 建议",
    ...readiness.training.map((item) => `- ${item}`),
    ...readiness.recovery.map((item) => `- ${item}`),
    ...readiness.sleep.map((item) => `- ${item}`),
    "",
    "## 数据质量",
    `- ${dataQuality.note}`
  ].join("\n");
}

function buildLivelyRideSummary(analysis) {
  const { activity, structure, history, wellness, recovery, dataQuality } = analysis;
  const recoveryHours = estimateRecoveryHours(activity, recovery, wellness);
  const statusLine = trainingStatusLine(recovery, history, wellness);
  const peakLines = peakPowerLines(activity);
  const zoneLines = compactZoneLines(activity.zoneHints);
  const heartLine = wellness.available
    ? `💚 HRV ${format(wellness.hrvToday, 0)}ms｜静息心率 ${format(wellness.restingHrToday, 0)}bpm｜睡眠 ${formatDuration(wellness.sleepTodaySec)}`
    : "💚 健康数据暂缺，恢复判断主要基于本次训练负荷";
  const balance = activity.leftRightBalance == null ? "暂无" : `${format(activity.leftRightBalance, 1)} / ${format(100 - activity.leftRightBalance, 1)}`;

  return summaryBlock("🧾 活动快照", [
    ["📌 今日训练状态", [
      `${statusLine.icon} ${statusLine.text}`,
      `📊 近7天负荷 ${format(history.load7d, 0)}｜近28天负荷 ${format(history.load28d, 0)}｜恢复压力 ${recovery.level}`,
      heartLine
    ]],
    ["🚴 骑行总结", [
      `🎯 ${structure.label}｜${structure.purpose}`,
      `📍 ${format(activity.distanceKm, 1)}km｜${activity.movingTimeText}｜爬升 ${format(activity.elevationM, 0)}m`,
      `⚡ 加权功率 ${watts(activity.weightedPowerW)}｜强度 ${format(activity.intensity, 2)}｜负荷 ${format(activity.load, 0)}`,
      `❤️ 心率 ${format(activity.avgHr, 0)}/${format(activity.maxHr, 0)}bpm｜踏频 ${format(activity.avgCadence, 0)}rpm｜左右 ${balance}`,
      `✨ 预计恢复时间 ${recoveryHours} 小时`
    ]],
    ["⚡ 峰值功率", peakLines],
    ["🌈 区间分布", zoneLines],
    ["🔎 数据提示", [
      dataQuality.note,
      activity.decouplingPct == null ? "Power/HR 漂移暂无" : `Power/HR 漂移 ${format(activity.decouplingPct, 1)}%，后程心率压力需要留意`
    ]]
  ]);
}

function buildBodySummary(analysis) {
  const { kind, wellness, activity, status, dataQuality } = analysis;
  const title = kind === "morning" ? "🌤️ 晨间身体状态" : "🌙 晚间身体小报";
  const activityTitle = activity.count ? "📊 当天训练" : "🚶 日常活动与恢复日";
  const activityLines = activity.count
    ? [
        `训练 ${activity.count} 项`,
        `总时长 ${formatDuration(activity.totalDurationSec)}`,
        `总负荷 ${format(activity.totalLoad, 0)}`,
        `消耗 ${format(activity.totalCalories, 0)} kcal`,
        ...activity.activities.slice(0, 4).map((item) => `🏃 ${item.name}｜${formatDuration(item.durationSec)}｜负荷 ${format(item.load, 0)}`)
      ]
    : [
        "今天没有训练记录，按日常恢复日处理",
        `步数 ${format(wellness.steps, 0)} 步`,
        `睡眠评分 ${format(wellness.sleepScore, 0)}`,
        `准备度 ${format(wellness.readiness, 0)}`,
        wellness.activeCalories == null ? "活动热量 暂无/未同步" : `活动热量 ${format(wellness.activeCalories, 0)} kcal`
      ];

  return summaryBlock(title, [
    ["📌 状态判定", [
      `${status.icon} ${status.label}`,
      ...status.reasons.map((reason) => `• ${reason}`)
    ]],
    ["💤 睡眠与恢复", [
      `睡眠 ${formatDuration(wellness.sleepTodaySec)}`,
      `7日均值 ${formatDuration(wellness.sleep7dAvgSec)}`,
      `睡眠差 ${formatSignedDuration(wellness.sleepDebtSec)}`,
      `睡眠评分 ${format(wellness.sleepScore, 0)}`,
      `睡眠效率 ${format(wellness.sleepEfficiency, 0)}%`,
      `深睡 ${formatDuration(wellness.deepSleepSec)}｜REM ${formatDuration(wellness.remSleepSec)}`,
      `睡眠均心率 ${format(wellness.avgSleepingHr, 0)} bpm`
    ]],
    ["💚 HRV 与心率", [
      `HRV ${format(wellness.hrvToday, 0)} ms`,
      `HRV 7日均值 ${format(wellness.hrv7dAvg, 0)} ms`,
      `HRV 变化 ${formatSignedPercent(wellness.hrvDeltaPct)}`,
      `静息心率 ${format(wellness.restingHrToday, 0)} bpm`,
      `静息心率变化 ${formatSigned(wellness.restingHrDelta, 1)} bpm`,
      `体温偏离 ${formatSigned(wellness.temperatureDeviation, 2)} ℃`
    ]],
    [activityTitle, [
      ...activityLines
    ]],
    ["🔎 数据提示", [
      `恢复数据源 ${wellness.dataSources?.oura ? "Oura API 优先" : "Intervals.icu wellness"}`,
      dataQuality.note,
      wellness.stress == null ? "压力指标未同步" : `压力指标 ${format(wellness.stress, 0)}`,
      wellness.bodyBattery == null ? "Body Battery/恢复电量未同步" : `Body Battery/恢复电量 ${format(wellness.bodyBattery, 0)}`
    ]]
  ]);
}

function buildRideEmailReport(analysis, aiReport) {
  const { activity, structure, history, wellness, dataQuality } = analysis;
  const livelySummary = buildLivelyRideSummary(analysis);
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

  return buildEmailShell({
    subject,
    title: `骑行分析｜${activity.date}`,
    subtitle: `${escapeHtml(activity.name)} · ${aiReport.source}`,
    summary: livelySummary,
    metrics,
    bodyMarkdown: aiReport.markdown
  });
}

function buildBodyEmailReport(analysis, aiReport) {
  const { kind, date, status, wellness, activity, dataQuality } = analysis;
  const isMorning = kind === "morning";
  const subject = `${isMorning ? "晨间身体状态" : "晚间身体小报"}｜${date} ${status.icon} ${status.label}`;
  const summary = buildBodySummary(analysis);
  const metrics = [
    ["状态", `${status.icon} ${status.label}`],
    ["睡眠", formatDuration(wellness.sleepTodaySec)],
    ["睡眠评分", format(wellness.sleepScore, 0)],
    ["睡眠 7 日均值", formatDuration(wellness.sleep7dAvgSec)],
    ["睡眠效率", wellness.sleepEfficiency == null ? "暂无/未同步" : `${format(wellness.sleepEfficiency, 0)}%`],
    ["深睡 / REM", `${formatDuration(wellness.deepSleepSec)} / ${formatDuration(wellness.remSleepSec)}`],
    ["睡眠均心率", wellness.avgSleepingHr == null ? "暂无/未同步" : `${format(wellness.avgSleepingHr, 0)} bpm`],
    ["最低睡眠心率", wellness.lowestSleepingHr == null ? "暂无/未同步" : `${format(wellness.lowestSleepingHr, 0)} bpm`],
    ["HRV 今日/7日均值", `${format(wellness.hrvToday, 0)} / ${format(wellness.hrv7dAvg, 0)} ms`],
    ["静息心率 今日/7日均值", `${format(wellness.restingHrToday, 0)} / ${format(wellness.restingHr7dAvg, 0)} bpm`],
    ["Oura 准备度", wellness.readiness == null ? "暂无/未同步" : format(wellness.readiness, 0)],
    ["体温偏离", wellness.temperatureDeviation == null ? "暂无/未同步" : `${formatSigned(wellness.temperatureDeviation, 2)} ℃`],
    ["呼吸率", wellness.respiratoryRate == null ? "暂无/未同步" : `${format(wellness.respiratoryRate, 1)} /min`],
    ["步数", wellness.steps == null ? "暂无/未同步" : `${format(wellness.steps, 0)} 步`],
    ["活动评分", wellness.activityScore == null ? "暂无/未同步" : format(wellness.activityScore, 0)],
    ["压力指标", wellness.stress == null ? "暂无/未同步" : format(wellness.stress, 0)],
    ["Body Battery/恢复电量", wellness.bodyBattery == null ? "暂无/未同步" : format(wellness.bodyBattery, 0)],
    ["恢复数据源", wellness.dataSources?.oura ? "Oura API + ICU" : "ICU wellness"],
    ["训练记录", activity.count ? `${format(activity.count, 0)} 项` : "无训练记录"],
    ["当天总负荷", format(activity.totalLoad, 0)],
    ["当天运动时长", formatDuration(activity.totalDurationSec)],
    ["数据完整度", dataQuality.completeness]
  ];

  return buildEmailShell({
    subject,
    title: `${isMorning ? "晨间身体状态" : "晚间身体小报"}｜${date}`,
    subtitle: `${status.icon} ${status.label} · ${aiReport.source}`,
    summary,
    metrics,
    bodyMarkdown: aiReport.markdown
  });
}

function buildEmailShell({ subject, title, subtitle, summary, metrics, bodyMarkdown }) {
  const html = `
    <main style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.6;color:#17202a;max-width:520px;margin:0 auto;padding:0 10px">
      <h2 style="margin:0 0 8px;font-size:22px;line-height:1.25">${escapeHtml(title)}</h2>
      <p style="margin:0 0 18px;color:#566573;font-size:14px;line-height:1.45">${subtitle}</p>
      ${summary.html}
      <h3 style="margin:18px 0 10px;font-size:17px;line-height:1.3">关键指标</h3>
      <div style="margin-bottom:20px">
        ${metrics.map(([label, value]) => metricCard(label, value)).join("")}
      </div>
      ${markdownToHtml(bodyMarkdown)}
      <p style="margin-top:24px;color:#7f8c8d;font-size:12px">数据来自 Intervals.icu/Garmin 与 Oura API；AI 只基于结构化指标生成决策建议，缺失字段不会被推测。</p>
    </main>`;
  const text = [title, "", stripHtml(subtitle), "", summary.text, "", "关键指标：", ...metrics.map(([label, value]) => `- ${label}: ${stripHtml(value)}`), "", stripMarkdown(bodyMarkdown)].join("\n");

  return { subject, html, text };
}

function metricCard(label, value) {
  return `
    <div style="border:1px solid #e5e8e8;border-radius:10px;padding:9px 11px;margin:7px 0;background:#ffffff">
      <div style="color:#566573;font-size:12px;line-height:1.25;margin-bottom:3px">${escapeHtml(label)}</div>
      <div style="font-weight:700;font-size:15px;line-height:1.35;word-break:break-word">${value}</div>
    </div>`;
}

function summaryBlock(title, sections) {
  const html = `
    <section style="background:#f7fbfb;border:1px solid #dcebea;border-radius:12px;padding:14px;margin:0 0 18px">
      <h3 style="margin:0 0 12px;color:#184e4a;font-size:17px;line-height:1.3">${escapeHtml(title)}</h3>
      ${sections.map(([sectionTitle, lines]) => `
        <div style="margin:13px 0 0">
          <div style="font-weight:700;color:#2c3e50;margin-bottom:6px;font-size:15px;line-height:1.35">${escapeHtml(sectionTitle)}</div>
          <div style="color:#25313b">${lines.map((line) => `<div style="margin:5px 0;font-size:14px;line-height:1.45;word-break:break-word">${escapeHtml(line)}</div>`).join("")}</div>
        </div>
      `).join("")}
    </section>`;
  const text = [title, ...sections.flatMap(([sectionTitle, lines]) => [sectionTitle, ...lines.map((line) => `- ${line}`), ""])].join("\n");
  return { html, text };
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

async function fetchActivities(env, athleteId, oldest, newest) {
  const data = await intervalsFetch(env, `/athlete/${athleteId}/activities?oldest=${oldest}&newest=${newest}`);
  return Array.isArray(data) ? data : [];
}

async function fetchWellnessRange(env, athleteId, oldest, newest) {
  const data = await safeIntervalsFetch(env, `/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${newest}`);
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

async function fetchOuraDailyData(env, oldest, newest) {
  if (!env.OURA_ACCESS_TOKEN) {
    return { enabled: false, errors: [] };
  }

  const endpoints = [
    ["dailySleep", `/daily_sleep?start_date=${oldest}&end_date=${newest}`],
    ["dailyReadiness", `/daily_readiness?start_date=${oldest}&end_date=${newest}`],
    ["dailyActivity", `/daily_activity?start_date=${oldest}&end_date=${newest}`],
    ["dailyStress", `/daily_stress?start_date=${oldest}&end_date=${newest}`],
    ["sleepSessions", `/sleep?start_date=${oldest}&end_date=${newest}`]
  ];

  const result = { enabled: true, errors: [] };
  await Promise.all(endpoints.map(async ([key, path]) => {
    try {
      const data = await ouraFetch(env, path);
      result[key] = Array.isArray(data?.data) ? data.data : [];
    } catch (error) {
      result[key] = [];
      result.errors.push({ endpoint: key, message: error.message });
    }
  }));

  return result;
}

async function ouraFetch(env, path) {
  const res = await fetch(`${OURA_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${env.OURA_ACCESS_TOKEN}`,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Oura ${res.status}: ${body.slice(0, 220)}`);
  }
  return res.json();
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

function rideOptions(url) {
  return {
    force: boolParam(url, "force"),
    dryRun: boolParam(url, "dry"),
    maxRides: intParam(url, "max", 6)
  };
}

function bodyOptions(url) {
  return {
    force: boolParam(url, "force"),
    dryRun: boolParam(url, "dry"),
    date: dateParam(url, "date")
  };
}

function isCyclingActivity(activity) {
  const type = String(activity.type || activity.sport || activity.icu_sport || "").toLowerCase();
  return ["ride", "virtualride", "cycling", "biking", "mountainbike", "gravelride"].some((item) => type.includes(item));
}

function activityLoad(activity) {
  return firstNumber(activity.icu_training_load, activity.training_load, activity.tss);
}

function activityIntensity(activity) {
  return normalizeIntensity(firstNumber(activity.icu_intensity, activity.intensity, activity.if));
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

function utcDateRangeAround(date, daysBack, daysForward) {
  const oldest = new Date(date);
  oldest.setUTCDate(date.getUTCDate() - daysBack);
  const newest = new Date(date);
  newest.setUTCDate(date.getUTCDate() + daysForward);
  return { oldest: isoDate(oldest), newest: isoDate(newest) };
}

function dateRangeFromIso(date, daysBack, daysForward) {
  const base = new Date(`${date}T00:00:00Z`);
  return utcDateRangeAround(base, daysBack, daysForward);
}

function chinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CHINA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateParam(url, name) {
  const value = url.searchParams.get(name);
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
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

function wellnessHints(wellness) {
  const hints = ["stress", "readiness", "recovery", "battery", "sleep", "oura", "steps", "calories", "strain", "activity"];
  return Object.keys(wellness || {})
    .filter((key) => hints.some((hint) => key.toLowerCase().includes(hint)))
    .slice(0, 40)
    .reduce((acc, key) => {
      if (typeof wellness[key] !== "object") acc[key] = wellness[key];
      return acc;
    }, {});
}

function matchOuraDay(items, date) {
  return (Array.isArray(items) ? items : []).find((item) => ouraItemDate(item) === date) || null;
}

function matchOuraMainSleep(items, date) {
  return mainSleepByDate(items).get(date) || null;
}

function recentOuraMainSleeps(items, date, days) {
  return [...mainSleepByDate(items).entries()]
    .filter(([itemDate]) => itemDate && itemDate <= date && daysBetween(itemDate, date) <= days)
    .map(([, item]) => item);
}

function mainSleepByDate(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const date = ouraItemDate(item);
    if (!date) continue;
    const existing = grouped.get(date);
    if (!existing || mainSleepRank(item) > mainSleepRank(existing)) grouped.set(date, item);
  }
  return grouped;
}

function mainSleepRank(item) {
  const duration = firstNumber(item?.total_sleep_duration, item?.total_sleep_duration_seconds) || 0;
  const typeBoost = String(item?.type || "").toLowerCase() === "long_sleep" ? 24 * 60 * 60 : 0;
  return typeBoost + duration;
}

function recentOuraDays(items, date, days) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const itemDate = ouraItemDate(item);
    return itemDate && itemDate <= date && daysBetween(itemDate, date) <= days;
  });
}

function ouraItemDate(item) {
  return localDate(item?.day || item?.date || item?.bedtime_end || item?.timestamp || item?.id || "");
}

function compactObject(object, allowedKeys) {
  if (!object) return null;
  return allowedKeys.reduce((acc, key) => {
    if (object[key] !== undefined) acc[key] = object[key];
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

function formatSigned(value, digits) {
  if (value == null || !Number.isFinite(Number(value))) return "暂无";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
}

function formatSignedPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return "暂无";
  return `${formatSigned(value, 1)}%`;
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
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function formatSignedDuration(value) {
  if (value == null) return "暂无";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatDuration(Math.abs(value))}`;
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
