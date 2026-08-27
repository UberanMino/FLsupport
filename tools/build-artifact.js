/*
 * build-artifact.js — inline the multi-file app into one self-contained HTML
 * page for publishing as a claude.ai Artifact (strict CSP, no external scripts).
 *
 *   node tools/build-artifact.js [outfile]
 *
 * Output omits <!doctype>/<html>/<head>/<body> (the Artifact host wraps those);
 * it is just an inline <style>, the app markup, and one inline <script>.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'mpc-studio.artifact.html');

const JS_ORDER = [
  'core', 'storage', 'export-encoders', 'sample', 'audio-engine', 'models',
  'transport', 'sequencer', 'render', 'host-bridge', 'app',
  'ui-pads', 'ui-mixer', 'ui-transport', 'ui-arrangement', 'ui-library', 'ui-main',
];

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bodyStart = html.indexOf('<body>') + '<body>'.length;
const scriptsAt = html.indexOf('<!-- load order');
if (bodyStart < 6 || scriptsAt < 0) throw new Error('Could not locate body markup in index.html');
const markup = html.slice(bodyStart, scriptsAt).trim();

const css = fs.readFileSync(path.join(ROOT, 'styles', 'main.css'), 'utf8');
const js = JS_ORDER
  .map((n) => '/* ================= js/' + n + '.js ================= */\n' + fs.readFileSync(path.join(ROOT, 'js', n + '.js'), 'utf8'))
  .join('\n\n');

const out = [
  '<style>', css, '</style>', '',
  markup, '',
  '<script>', js, '</script>', '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log('Wrote ' + OUT + ' (' + (out.length / 1024).toFixed(1) + ' KB)');
