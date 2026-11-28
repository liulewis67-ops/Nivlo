#!/usr/bin/env node
/** Verify evidence identity, not human acceptance or screenshot quality. */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const stage='tests/visual/stages/m5';
const read=path=>JSON.parse(readFileSync(join(root,path),'utf8'));
const hash=path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const manifest=read(`${stage}/manifest.json`);
const review=read(`${stage}/visual-review.json`);
assert(manifest.artifacts.length===44,'Expected all 44 current-candidate scenes');
for(const [path,expected]of Object.entries(manifest.sourceFiles))assert(hash(path)===expected,`Stale browser source: ${path}`);
for(const artifact of manifest.artifacts){
  assert(hash(`${stage}/${artifact.file}`)===artifact.sha256,`Changed capture: ${artifact.file}`);
  assert(review.artifacts.some(r=>r.name===artifact.name&&r.sha256===artifact.sha256),`Missing matching review: ${artifact.name}`);
  assert(!artifact.pageOverflow,`Page overflow recorded: ${artifact.name}`);
}
assert(manifest.measurements.length===2,'Expected Notes and Search dense measurements');
for(const trial of manifest.measurements){
  assert(trial.count===1000&&trial.timings.length===10,`Incomplete dense fixture: ${trial.scene}`);
  assert(trial.timings.every(t=>Number.isFinite(t)&&t>=0),`Invalid timing: ${trial.scene}`);
}
const goldens='tests/visual/baselines/win32';
const regression=read(`${goldens}/manifest.json`);
assert(regression.artifacts.length===6,'Missing historical regression scenes');
for(const [path,expected]of Object.entries(regression.sourceFiles))assert(hash(path)===expected,`Stale regression source: ${path}`);
for(const artifact of regression.artifacts){
  assert(hash(`${goldens}/${artifact.file}`)===artifact.sha256,`Changed golden: ${artifact.file}`);
  assert(review.regression.some(r=>r.name===artifact.name&&r.sha256===artifact.sha256),`Missing golden review: ${artifact.name}`);
}
const native=read(`${stage}/native/measurements.json`);
assert(native.failedScenarios===0,'Native run recorded failures');
assert(native.warm.length>=20&&native.warmBudgetPassed&&native.warmP95<150,'Native warm-focus budget not passed');
assert(native.cold.length===3,'Expected three separate cold search activations');
assert(native.runtimeEnvironments.length===3,'Missing per-run native runtime records');
assert(native.zoom.length===6&&native.badges.length===4,'Missing native zoom/badge matrix');
assert(hash('target/release/asterjot-desktop.exe')===native.executableSha256,'Release executable differs from tested executable');
assert(hash('tests/e2e/e2e.mjs')===native.harnessSha256,'Native harness changed after measurement');
for(const [path,expected]of Object.entries(native.sourceFiles))assert(hash(path)===expected,`Stale native source: ${path}`);
for(const zoom of native.zoom){
  const file=zoom.screenshotFile??`main-200pct-${zoom.run}.png`;
  assert(existsSync(join(root,stage,'native',file)),`Missing zoom screenshot: ${file}`);
  assert(hash(`${stage}/native/${file}`)===zoom.screenshotSha256,`Changed zoom screenshot: ${file}`);
  assert(review.native.some(r=>r.file===file&&r.sha256===zoom.screenshotSha256),`Missing native zoom review: ${file}`);
  if(zoom.surface==='search'){
    assert(zoom.frames.length===10,'Missing stable search fitting samples');
    for(const frame of zoom.frames)assert(frame.focus&&!frame.overflow&&frame.footer<=frame.height+1&&frame.row.top>=frame.list.top-1&&frame.row.bottom<=frame.list.bottom+1,'Search zoom clipping/focus failure');
    assert(new Set(zoom.frames.slice(-5).map(f=>f.height)).size===1,'Search fitting did not settle');
  } else assert(zoom.editor.focus&&zoom.editor.stable&&zoom.editor.modal==='true','Main zoom editor state failed');
}
for(const badge of native.badges){
  const file=`badge-${badge.name}.png`;
  assert(hash(`${stage}/native/${file}`)===badge.sha256,`Changed badge screenshot: ${badge.name}`);
  assert(review.native.some(r=>r.file===file&&r.sha256===badge.sha256),`Missing badge review: ${badge.name}`);
}
console.log('Evidence identity verified: 44 reviewed scenes, 6 reviewed goldens, 2000 dense rows, 3 native runs, 6 zoom checks, 4 badge shapes, 20+ warm activations.');
console.log('This verifies recorded evidence identity and assertions; human/manual release gaps remain in the acceptance handoff.');
