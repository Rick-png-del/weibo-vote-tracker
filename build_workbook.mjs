import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const [payloadPath, outputDir] = process.argv.slice(2);
if (!payloadPath || !outputDir) {
  throw new Error("Usage: node build_workbook.mjs <payload.json> <output-dir>");
}

const payload = JSON.parse(await fs.readFile(payloadPath, "utf8"));
await fs.mkdir(outputDir, { recursive: true });

function shanghaiWallTime(isoString) {
  const match = String(isoString).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return new Date(isoString);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

const workbook = Workbook.create();
const summary = workbook.worksheets.add("当前排名");
const history = workbook.worksheets.add("历史票数");
const font = "Arial";
const navy = "#17324D";
const orange = "#FF8200";
const paleOrange = "#FFF1E8";
const line = "#D8E0E8";
const text = "#1E293B";

summary.showGridLines = false;
summary.tabColor = navy;
summary.getRange("A2:G2").format.borders = {
  bottom: { style: "medium", color: orange },
};
summary.getRange("A2").values = [[`${payload.activity_name}票数监测`]];
summary.getRange("A2").format.font = { name: font, size: 16, bold: true, color: navy };
summary.getRange("A3:D3").values = [[
  "采集时间",
  shanghaiWallTime(payload.collected_at),
  "候选人数",
  payload.current.length,
]];
summary.getRange("A3:D3").format.font = { name: font, size: 10, color: text };
summary.getRange("B3").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
summary.getRange("D3").format.numberFormat = "#,##0";

const currentHeaders = [["排名", "候选人", `票数（${payload.vote_unit}）`, "较上次", "投票人数", "项目 ID", "微博 UID"]];
const currentRows = payload.current.map((item) => [
  item.rank,
  item.name,
  item.votes,
  item.delta,
  item.voters,
  item.item_id,
  item.uid,
]);
summary.getRange("A5:G5").values = currentHeaders;
if (currentRows.length) {
  summary.getRangeByIndexes(5, 0, currentRows.length, 7).values = currentRows;
}
summary.getRange(`A5:G${5 + currentRows.length}`).format.font = { name: font, size: 10, color: text };
summary.getRange("A5:G5").format = {
  fill: navy,
  font: { name: font, size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "inside", style: "thin", color: "#FFFFFF" },
};
summary.getRange(`A6:A${5 + currentRows.length}`).format.horizontalAlignment = "center";
summary.getRange(`C6:E${5 + currentRows.length}`).format.numberFormat = "#,##0";
summary.getRange(`F6:G${5 + currentRows.length}`).format.numberFormat = "@";
summary.getRange(`A6:G${5 + currentRows.length}`).format.borders = {
  bottom: { style: "thin", color: line },
};
summary.getRange(`C6:C${5 + currentRows.length}`).conditionalFormats.add("dataBar", {
  color: orange,
  gradient: true,
});
summary.getRange("A5:G5").format.rowHeightPx = 26;
summary.getRange("A:A").format.columnWidthPx = 58;
summary.getRange("B:B").format.columnWidthPx = 175;
summary.getRange("C:E").format.columnWidthPx = 105;
summary.getRange("F:G").format.columnWidthPx = 105;
summary.freezePanes.freezeRows(5);

const reversedTop = payload.current.slice(0, 20).reverse();
summary.getRange("I28:J28").values = [["候选人", `票数（${payload.vote_unit}）`]];
summary.getRangeByIndexes(28, 8, reversedTop.length, 2).values = reversedTop.map((item) => [
  item.name,
  item.votes,
]);
summary.getRange(`I28:J${28 + reversedTop.length}`).format.font = { name: font, size: 9, color: text };
summary.getRange("I28:J28").format = {
  fill: paleOrange,
  font: { name: font, size: 9, bold: true, color: navy },
};
summary.getRange("I:I").format.columnWidthPx = 160;
summary.getRange("J:J").format.columnWidthPx = 100;
summary.getRange(`J29:J${28 + reversedTop.length}`).format.numberFormat = "#,##0";

const chart = summary.charts.add("bar", summary.getRange(`I28:J${28 + reversedTop.length}`));
chart.barOptions.direction = "bar";
chart.barOptions.grouping = "clustered";
chart.barOptions.gapWidth = 55;
chart.title = "当前票数前 20 名";
chart.titleTextStyle.fontSize = 12;
chart.titleTextStyle.typeface = font;
chart.hasLegend = false;
chart.xAxis = {
  numberFormatCode: "#,##0",
  numberFormatSourceLinked: false,
  textStyle: { typeface: font, fontSize: 9 },
};
chart.yAxis = { textStyle: { typeface: font, fontSize: 9 } };
chart.setPosition("I5", "Q25");
if (chart.series.items.length) {
  chart.series.items[0].fill = orange;
}

history.showGridLines = false;
history.getRange("A2:N2").format.borders = {
  bottom: { style: "medium", color: orange },
};
history.getRange("A2").values = [[`${payload.activity_name}历史票数`]];
history.getRange("A2").format.font = { name: font, size: 16, bold: true, color: navy };
history.getRange("A3").values = [[`数据源：${payload.source}`]];
history.getRange("A3").format.font = { name: font, size: 9, italic: true, color: "#64748B" };

const historyOrder = payload.history.order;
const historyItems = payload.history.items;
const historyHeaders = [
  "采集时间",
  ...historyOrder.map((id) => `${historyItems[id]?.name ?? id} [${id}]`),
];
history.getRangeByIndexes(4, 0, 1, historyHeaders.length).values = [historyHeaders];
const historyRows = payload.history.rows.map((row) => [shanghaiWallTime(row[0]), ...row.slice(1)]);
if (historyRows.length) {
  history.getRangeByIndexes(5, 0, historyRows.length, historyHeaders.length).values = historyRows;
}
history.getRangeByIndexes(4, 0, 1, historyHeaders.length).format = {
  fill: navy,
  font: { name: font, size: 9, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
history.getRangeByIndexes(5, 0, Math.max(historyRows.length, 1), historyHeaders.length).format.font = {
  name: font,
  size: 9,
  color: text,
};
history.getRangeByIndexes(5, 0, Math.max(historyRows.length, 1), 1).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
if (historyHeaders.length > 1) {
  history.getRangeByIndexes(5, 1, Math.max(historyRows.length, 1), historyHeaders.length - 1).format.numberFormat = "#,##0";
}
history.getRange("A:A").format.columnWidthPx = 145;
if (historyHeaders.length > 1) {
  history.getRangeByIndexes(0, 1, Math.max(historyRows.length + 5, 6), historyHeaders.length - 1).format.columnWidthPx = 145;
}
history.getRangeByIndexes(4, 0, Math.max(historyRows.length + 1, 2), historyHeaders.length).format.borders = {
  bottom: { style: "thin", color: line },
};
history.freezePanes.freezeRows(5);
history.freezePanes.freezeColumns(1);

workbook.recalculate();

const summaryCheck = await workbook.inspect({
  kind: "table",
  range: "当前排名!A2:G12",
  include: "values,formulas",
  tableMaxRows: 12,
  tableMaxCols: 7,
});
const historyCheck = await workbook.inspect({
  kind: "table",
  range: `历史票数!A2:N${Math.min(8, 5 + historyRows.length)}`,
  include: "values,formulas",
  tableMaxRows: 8,
  tableMaxCols: 14,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});

const preview = await workbook.render({
  sheetName: "当前排名",
  range: "A1:Q49",
  scale: 1,
  format: "png",
});
await fs.writeFile(path.join(outputDir, "current_top20.png"), new Uint8Array(await preview.arrayBuffer()));

const historyPreview = await workbook.render({
  sheetName: "历史票数",
  range: `A1:N${Math.min(10, 5 + historyRows.length)}`,
  scale: 1,
  format: "png",
});
const historyPreviewPath = path.join(outputDir, ".history_preview.png");
await fs.writeFile(historyPreviewPath, new Uint8Array(await historyPreview.arrayBuffer()));

const output = await SpreadsheetFile.exportXlsx(workbook);
const workbookPath = path.join(outputDir, "weibo_vote_tracker.xlsx");
await output.save(workbookPath);

console.log(JSON.stringify({
  workbook: workbookPath,
  chart: path.join(outputDir, "current_top20.png"),
  candidateCount: payload.current.length,
  snapshotCount: historyRows.length,
  summaryCheck: summaryCheck.ndjson,
  historyCheck: historyCheck.ndjson,
  formulaErrors: errors.ndjson,
}));
