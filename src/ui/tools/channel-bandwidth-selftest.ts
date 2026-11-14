// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 vllogic.com
/**
 * Offline checks for the Logic20 channel/rate bandwidth policy.
 *
 *   node_modules/.bin/esbuild src/ui/tools/channel-bandwidth-selftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/channel-bandwidth.mjs && node /tmp/channel-bandwidth.mjs
 */

import {
  VLLOGIC_FIFO_HARD_MBPS, VLLOGIC_LINK_MBPS,
  aboveLinkLimit, exceedsHardLimit, formatChannelList, maxChannelsForBandwidth,
  selectionBandwidthMbps, trimChannelSelection, type ChannelSelection,
} from '../channelBandwidth.js';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
const nodeProcess = (() => {
  const process = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!process || typeof process.exit !== 'function') throw new Error('this entry point only runs under node');
  return process;
})();
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const M = 1e6;
const pick = (channels: readonly number[], at = 0): ChannelSelection[] =>
  channels.map((channel) => ({ channel, selectedAt: at }));

check(
  'bandwidth is selected lanes times rate',
  selectionBandwidthMbps(20, 120 * M) === 2400 &&
    selectionBandwidthMbps(3, 1200 * M) === 3600 &&
    selectionBandwidthMbps(0, 1200 * M) === 0,
  `20@120M=${selectionBandwidthMbps(20, 120 * M)} 3@1200M=${selectionBandwidthMbps(3, 1200 * M)}`,
);

check(
  'hard and link limits match the hardware envelope',
  VLLOGIC_FIFO_HARD_MBPS === 4500 && VLLOGIC_LINK_MBPS === 2560 &&
    exceedsHardLimit(4, 1200 * M) && !exceedsHardLimit(3, 1200 * M) &&
    aboveLinkLimit(3, 1200 * M) && !aboveLinkLimit(2, 1200 * M) &&
    maxChannelsForBandwidth(1200 * M, VLLOGIC_FIFO_HARD_MBPS) === 3 &&
    maxChannelsForBandwidth(600 * M, VLLOGIC_FIFO_HARD_MBPS) === 7 &&
    maxChannelsForBandwidth(300 * M, VLLOGIC_FIFO_HARD_MBPS) === 15 &&
    maxChannelsForBandwidth(150 * M, VLLOGIC_FIFO_HARD_MBPS) === 30,
  `4@1200=${exceedsHardLimit(4, 1200 * M)} 3@1200=${exceedsHardLimit(3, 1200 * M)} ` +
    `3@1200link=${aboveLinkLimit(3, 1200 * M)}`,
);

{
  // All channels selected at once: equal timestamps close the high numbers first.
  const trim = trimChannelSelection({ selected: pick([0, 1, 2, 3]), rateHz: 1200 * M });
  check(
    'a same-time selection keeps the low channels',
    trim.kept.join(',') === '0,1,2' && trim.closed.join(',') === '3',
    `kept=${trim.kept.join(',')} closed=${trim.closed.join(',')}`,
  );
}

{
  // Row 0 was picked first, row 2 last: the early low lanes go first, then D19.
  const selected = [
    ...pick([0, 1, 2, 3, 4, 5, 6, 7], 1),
    ...pick([8, 9, 10, 11, 12, 13, 14, 15], 2),
    ...pick([16, 17, 18, 19], 3),
  ];
  const trim = trimChannelSelection({ selected, rateHz: 1200 * M });
  check(
    'the oldest selected lanes close first',
    trim.closed.join(',') === '7,6,5,4,3,2,1,0,15,14,13,12,11,10,9,8,19' &&
      trim.kept.join(',') === '16,17,18',
    `kept=${trim.kept.join(',')} closed=${trim.closed.join(',')}`,
  );
}

{
  // The trigger channel is protected, so a cheaper lane closes first. With only one
  // close needed the protected lanes survive...
  const selected = pick([0, 1, 2, 3]);
  const trim = trimChannelSelection({
    selected, rateHz: 1200 * M, protectedChannels: new Set([0, 1]),
  });
  check(
    'referenced channels close only after unprotected ones',
    trim.closed.join(',') === '3' && trim.kept.join(',') === '0,1,2',
    `kept=${trim.kept.join(',')} closed=${trim.closed.join(',')}`,
  );
  // ...but when the unprotected lanes are exhausted the protected ones still close.
  const allProtected = trimChannelSelection({
    selected, rateHz: 1200 * M, limitMbps: 2000, protectedChannels: new Set([0, 1]),
  });
  check(
    'protected channels are still closed when nothing else is left',
    allProtected.kept.join(',') === '0' && allProtected.closed.join(',') === '3,2,1' &&
      selectionBandwidthMbps(allProtected.kept.length, 1200 * M) <= 2000,
    `kept=${allProtected.kept.join(',')} closed=${allProtected.closed.join(',')}`,
  );
  const allProtectedSet = trimChannelSelection({
    selected, rateHz: 1200 * M, protectedChannels: new Set([0, 1, 2, 3]),
  });
  check(
    'an all-protected set closes its latest channel first',
    allProtectedSet.kept.join(',') === '0,1,2' && allProtectedSet.closed.join(',') === '3' &&
      selectionBandwidthMbps(allProtectedSet.kept.length, 1200 * M) <= VLLOGIC_FIFO_HARD_MBPS,
    `kept=${allProtectedSet.kept.join(',')} closed=${allProtectedSet.closed.join(',')}`,
  );
}

{
  const trim = trimChannelSelection({ selected: pick([0, 1]), rateHz: 1200 * M });
  check(
    'a set already inside the limit is untouched, even at one lane',
    trim.kept.join(',') === '0,1' && trim.closed.length === 0,
    `kept=${trim.kept.join(',')} closed=${trim.closed.length}`,
  );
  const one = trimChannelSelection({ selected: pick([7]), rateHz: 1200 * M });
  check('one lane is never closed', one.kept.join(',') === '7' && one.closed.length === 0,
    `kept=${one.kept.join(',')} closed=${one.closed.length}`);
}

check(
  'the notice list uses the D labels',
  formatChannelList([7, 6, 5]) === 'D7, D6, D5',
  formatChannelList([7, 6, 5]),
);

// ---- wiring: the app selects lanes, the panel renders the row button/notices -----
{
  interface FsLike { readFileSync(path: string, encoding: string): string }
  const fs = (globalThis as {
    process?: { getBuiltinModule?(name: string): unknown };
  }).process?.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const locales = ['en', 'fr', 'ru', 'zh-CN'].map((name) =>
    fs.readFileSync(`src/ui/locales/${name}.ts`, 'utf8'));
  const wired = app.includes('selectedChannels: this.selectedChannels()') &&
    app.includes('store.setActiveChannels?.(cfg.selectedChannels)') &&
    app.includes('this.captureLimitSamples + 32, cfg.selectedChannels') &&
    app.includes('private enforceChannelBandwidth(): void') &&
    (app.match(/this\.enforceChannelBandwidth\(\);/g) ?? []).length >= 4 &&
    app.includes('private dropChannelReferences(closed: readonly number[]): void') &&
    app.includes('private setChannelBankSelected(start: number, select: boolean): void') &&
    app.includes('if (this.isLaneSelectDevice()) return [];');
  check(
    'the app streams the selected lanes, trims them and clears stale references',
    wired,
    `selection=${app.includes('selectedChannels: this.selectedChannels()')} ` +
      `sparse=${app.includes('store.setActiveChannels?.(cfg.selectedChannels)')} ` +
      `trim=${(app.match(/this\.enforceChannelBandwidth\(\);/g) ?? []).length} ` +
      `widthHidden=${app.includes('if (this.isLaneSelectDevice()) return [];')}`,
  );
  const rendered = panel.includes("select.className = 'bank-select'") &&
    panel.includes('onSelectBank(start, !allSelected)') &&
    panel.includes('capturePanel.channelsForcedOff') &&
    panel.includes('capturePanel.rateAboveLink') &&
    panel.includes('aboveLinkLimit(selected, s.samplerate)') &&
    sheet.includes('.bank-select {') && sheet.includes('flex: 0 0 64px');
  check(
    'the panel renders fixed-width row select and the two Logic20 notices',
    rendered,
    `button=${panel.includes("select.className = 'bank-select'")} ` +
      `forced=${panel.includes('capturePanel.channelsForcedOff')} ` +
      `link=${panel.includes('capturePanel.rateAboveLink')} sheet=${sheet.includes('.bank-select {')}`,
  );
  const translated = locales.every((body) =>
    body.includes("'capturePanel.rateAboveLink'") &&
    body.includes("'capturePanel.channelsForcedOff'") &&
    body.includes("'capturePanel.selectAll'") &&
    body.includes("'capturePanel.selectNone'"));
  check('all four locales carry the select and bandwidth strings', translated, `locales=${locales.length}`);
}

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) nodeProcess.exit(1);
