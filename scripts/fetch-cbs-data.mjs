import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputFile = path.join(rootDir, "site", "data.json");

const API_ROOT = "https://datasets.cbs.nl/odata/v1/CBS";
const EMPLOYMENT_TABLE = "85276NED";
const PAY_TABLE = "85517NED";
const EMPLOYMENT_CURRENT_PERIOD = "2025KW04";
const EMPLOYMENT_COMPARISON_PERIOD = "2024KW04";
const PAY_PERIOD = "2024JJ00";
const EMPLOYMENT_CURRENT_LABEL = "2025 Q4";
const EMPLOYMENT_COMPARISON_LABEL = "2024 Q4";
const PAY_LABEL = "2024 annual";

function buildUrl(base, params = {}) {
  const url = new URL(base);

  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchAll(url) {
  const rows = [];
  let nextUrl = url;

  while (nextUrl) {
    const payload = await fetchJson(nextUrl);
    if (Array.isArray(payload.value)) {
      rows.push(...payload.value);
    }
    nextUrl = payload["@odata.nextLink"] ?? null;
  }

  return rows;
}

function extractHierarchyCode(title) {
  const match = title.match(/^(\d{2,4})\s+/);
  return match ? match[1] : null;
}

function normalizeLabel(entry) {
  const descriptionPrefix = entry.Description?.split(":")[0]?.trim();
  if (descriptionPrefix) {
    return descriptionPrefix.replace(/\.$/, "");
  }

  return entry.Title.replace(/^\d{2,4}\s+/, "").replace(/\.\.\.$/, "").trim();
}

function percentage(part, total) {
  if (part == null || total == null || total === 0) {
    return null;
  }

  return part / total;
}

function percentageChange(nextValue, prevValue) {
  if (nextValue == null || prevValue == null || prevValue === 0) {
    return null;
  }

  return ((nextValue - prevValue) / prevValue) * 100;
}

function roundNumber(value, digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricLabel(value, unit) {
  if (value == null) {
    return null;
  }

  return { value, unit };
}

function setNestedMetric(store, key, period, value) {
  if (!store[key]) {
    store[key] = {};
  }

  store[key][period] = value;
}

async function main() {
  const [
    employmentCodes,
    payCodes,
    employmentObservations,
    payObservations,
  ] = await Promise.all([
    fetchAll(`${API_ROOT}/${EMPLOYMENT_TABLE}/BeroepCodes`),
    fetchAll(`${API_ROOT}/${PAY_TABLE}/BeroepCodes`),
    fetchAll(
      buildUrl(`${API_ROOT}/${EMPLOYMENT_TABLE}/Observations`, {
        $filter: `(Perioden eq '${EMPLOYMENT_COMPARISON_PERIOD}' or Perioden eq '${EMPLOYMENT_CURRENT_PERIOD}')`,
      }),
    ),
    fetchAll(
      buildUrl(`${API_ROOT}/${PAY_TABLE}/Observations`, {
        $filter: `Perioden eq '${PAY_PERIOD}'`,
      }),
    ),
  ]);

  const payLeafCodeSet = new Set(
    payCodes
      .map((entry) => extractHierarchyCode(entry.Title))
      .filter((code) => code && code.length === 4),
  );

  const classByCode = new Map();
  const segmentByCode = new Map();
  const leafByCode = new Map();

  for (const entry of employmentCodes) {
    const code = extractHierarchyCode(entry.Title);
    if (!code) {
      continue;
    }

    const label = normalizeLabel(entry);
    if (code.length === 2) {
      classByCode.set(code, label);
    } else if (code.length === 3) {
      segmentByCode.set(code, label);
    } else if (code.length === 4 && payLeafCodeSet.has(code)) {
      leafByCode.set(code, label);
    }
  }

  const employmentByOccupation = {};
  const womenByOccupation = {};
  const highEducationByOccupation = {};

  for (const row of employmentObservations) {
    const code = extractHierarchyCode(
      employmentCodes.find((entry) => entry.Identifier === row.Beroep)?.Title ?? "",
    );

    if (!code || code.length !== 4 || !leafByCode.has(code) || row.Value == null) {
      continue;
    }

    const people = Math.round(row.Value * 1000);

    if (row.Geslacht === "T001038" && row.Persoonskenmerken === "T009002") {
      setNestedMetric(employmentByOccupation, code, row.Perioden, people);
    }

    if (row.Perioden === EMPLOYMENT_CURRENT_PERIOD) {
      if (row.Geslacht === "4000" && row.Persoonskenmerken === "T009002") {
        womenByOccupation[code] = people;
      }

      if (row.Geslacht === "T001038" && row.Persoonskenmerken === "2018790") {
        highEducationByOccupation[code] = people;
      }
    }
  }

  const payByOccupation = {};

  for (const row of payObservations) {
    const code = extractHierarchyCode(
      payCodes.find((entry) => entry.Identifier === row.Beroep)?.Title ?? "",
    );

    if (!code || code.length !== 4 || !leafByCode.has(code) || row.Value == null) {
      continue;
    }

    if (!payByOccupation[code]) {
      payByOccupation[code] = {};
    }

    payByOccupation[code][row.Measure] = row.Value;
  }

  const occupations = [...leafByCode.entries()]
    .map(([code, title]) => {
      const categoryCode = code.slice(0, 2);
      const segmentCode = code.slice(0, 3);
      const jobsCurrent = employmentByOccupation[code]?.[EMPLOYMENT_CURRENT_PERIOD] ?? null;
      const jobsComparison = employmentByOccupation[code]?.[EMPLOYMENT_COMPARISON_PERIOD] ?? null;
      const women = womenByOccupation[code] ?? null;
      const highEducation = highEducationByOccupation[code] ?? null;
      const pay = payByOccupation[code] ?? {};

      return {
        code,
        title,
        segmentCode,
        segment: segmentByCode.get(segmentCode) ?? segmentCode,
        categoryCode,
        category: classByCode.get(categoryCode) ?? categoryCode,
        jobs: jobsCurrent,
        jobsComparison,
        growth1y: roundNumber(percentageChange(jobsCurrent, jobsComparison), 1),
        womenShare: roundNumber(percentage(women, jobsCurrent), 4),
        higherEducationShare: roundNumber(percentage(highEducation, jobsCurrent), 4),
        medianHourlyPay: roundNumber(pay.D005607 ?? null, 2),
        payP25: roundNumber(pay.A043067 ?? null, 2),
        payP75: roundNumber(pay.A043069 ?? null, 2),
        employeesInPayData: pay["2021320"] != null ? Math.round(pay["2021320"] * 1000) : null,
        sourceUrl: "https://dataportal.cbs.nl/detail/CBS/nl/dataset/85276NED",
      };
    })
    .filter((occupation) => occupation.jobs && occupation.jobs > 0)
    .sort((a, b) => b.jobs - a.jobs);

  const totalJobs = occupations.reduce((sum, occupation) => sum + occupation.jobs, 0);
  const weighted = (key) => {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const occupation of occupations) {
      const value = occupation[key];
      if (value == null || occupation.jobs == null) {
        continue;
      }

      weightedSum += value * occupation.jobs;
      totalWeight += occupation.jobs;
    }

    return totalWeight ? weightedSum / totalWeight : null;
  };

  const payload = {
    meta: {
      title: "Netherlands Job Market Visualizer",
      employmentCurrentPeriod: EMPLOYMENT_CURRENT_LABEL,
      employmentComparisonPeriod: EMPLOYMENT_COMPARISON_LABEL,
      payPeriod: PAY_LABEL,
      occupationCount: occupations.length,
      totalJobs,
      generatedAt: new Date().toISOString(),
      sources: [
        {
          table: EMPLOYMENT_TABLE,
          title: "Werkzame beroepsbevolking; beroep",
          url: "https://dataportal.cbs.nl/detail/CBS/nl/dataset/85276NED",
        },
        {
          table: PAY_TABLE,
          title: "Werknemers; uurloon en beroep",
          url: "https://dataportal.cbs.nl/detail/CBS/nl/dataset/85517NED",
        },
      ],
      summary: {
        medianHourlyPayWeighted: roundNumber(weighted("medianHourlyPay"), 2),
        womenShareWeighted: roundNumber(weighted("womenShare"), 4),
        higherEducationShareWeighted: roundNumber(weighted("higherEducationShare"), 4),
        growth1yWeighted: roundNumber(weighted("growth1y"), 1),
      },
      notes: [
        "Area uses employed workforce in 2025 Q4 from CBS table 85276NED.",
        "Growth compares 2025 Q4 employment with 2024 Q4 employment.",
        "Women share and higher-education share are based on the same 2025 Q4 employment table.",
        "Median hourly pay uses the 2024 annual median from CBS table 85517NED because the pay table does not yet publish 2025 quarter values.",
      ],
    },
    occupations,
  };

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `Wrote ${occupations.length} occupations and ${totalJobs.toLocaleString("en-US")} represented workers to ${outputFile}`,
  );
  console.log(
    JSON.stringify(
      {
        averageMedianHourlyPay: metricLabel(payload.meta.summary.medianHourlyPayWeighted, "EUR/hour"),
        womenShare: metricLabel(payload.meta.summary.womenShareWeighted, "share"),
        higherEducationShare: metricLabel(payload.meta.summary.higherEducationShareWeighted, "share"),
        growth1y: metricLabel(payload.meta.summary.growth1yWeighted, "pct"),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
