/* SecureGate Lite — app.js */
'use strict';

const $    = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

// ─── Audit log ───────────────────────────────────────────────────────
let auditLines = [];
function audit(msg, cls='') {
  const ts   = new Date().toISOString().replace('T',' ').slice(0,19);
  const line = '['+ts+'] '+msg;
  auditLines.push(line);
  const el   = $('auditLog');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line + '\n';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}
function clearAudit()  { auditLines=[]; $('auditLog').innerHTML=''; }
function exportAudit() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([auditLines.join('\n')],{type:'text/plain'}));
  a.download = 'securegate-audit-'+Date.now()+'.log';
  a.click();
  audit('Audit log exported');
}

// ─── Load chains ────────────────────────────────────────────────────
let allChains = [];
async function loadChains() {
  try {
    allChains = await fetch('/api/chains').then(r => r.json());
    const sel = $('chainSelect');
    sel.innerHTML = '<option value="">Select chain…</option>';
    allChains.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + ' (' + c.symbol + ')';
      sel.appendChild(o);
    });
    audit('Loaded ' + allChains.length + ' chains');
  } catch(e) { audit('ERROR loading chains: ' + e.message, 'log-fail'); }
}

// ─── Compile badge ───────────────────────────────────────────────
async function runCompile() {
  const badge = $('compileBadge');
  badge.textContent = 'COMPILING…';
  badge.style.background = '#885500';
  audit('Compiling SecureGate.sol…');
  try {
    const r = await fetch('/api/compile').then(r => r.json());
    if (!r.ok) throw new Error(r.error);
    badge.textContent = '✓ COMPILED';
    badge.classList.add('ok');
    audit('Compiled — ABI entries: ' + r.abiEntries + ', bytecode: ' + r.bytecodeBytes + ' bytes', 'log-pass');
  } catch(e) {
    badge.textContent = '✗ COMPILE FAILED';
    badge.style.background = 'var(--fail)';
    audit('Compile error: ' + e.message, 'log-fail');
  }
}

// ─── Gas estimate (standalone — Section 2 button) ──────────────────────
async function runGasEstimate() {
  const chainId     = $('chainSelect').value;
  const rpcOverride = $('rpcOverride').value.trim() || null;
  if (!chainId) { alert('Select a chain first'); return; }
  hide('gasResult');
  audit('Requesting gas estimate for chain ' + chainId + '…');
  try {
    const data = await fetch('/api/gas/estimate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chainId: Number(chainId), rpcOverride })
    }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    $('gasResult').textContent = [
      'Chain            : ' + data.chainName,
      'Gas price        : ' + data.gasPrice,
      'Base fee         : ' + data.baseFee,
      'Est. deploy gas  : ' + Number(data.estimatedDeployGas).toLocaleString() + ' units',
      'Est. deploy cost : ' + data.estimatedDeployCost,
      'Block            : ' + data.blockNumber,
    ].join('\n');
    show('gasResult');
    audit('Gas: ' + data.estimatedDeployCost + ' on ' + data.chainName, 'log-pass');
    return data;
  } catch(e) {
    $('gasResult').textContent = 'ERROR: ' + e.message;
    show('gasResult');
    audit('Gas estimate error: ' + e.message, 'log-fail');
    throw e;
  }
}

// ─── Revocations list ────────────────────────────────────────────────
let revokeItems = [];
function addRevoke() {
  const type = $('revokeType').value;
  const token = $('revokeToken').value.trim();
  const op    = $('revokeOperator').value.trim();
  if (!token || !op) { alert('Enter both token and operator/spender addresses'); return; }
  revokeItems.push({ type, token, operator: op });
  $('revokeToken').value = ''; $('revokeOperator').value = '';
  renderRevokeList();
  audit('Queued ' + type.toUpperCase() + ' revocation: ' + token + ' / ' + op);
}
function renderRevokeList() {
  const el = $('revokeList');
  el.innerHTML = '';
  revokeItems.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'revoke-item';
    div.innerHTML = '<span class="rtag">' + item.type.toUpperCase() + '</span>' +
      '<span>' + item.token + '</span><span>→</span><span>' + item.operator + '</span>' +
      '<span class="rrm" data-i="' + i + '">×</span>';
    el.appendChild(div);
  });
  el.querySelectorAll('.rrm').forEach(btn => btn.addEventListener('click', () => {
    revokeItems.splice(Number(btn.dataset.i), 1); renderRevokeList();
  }));
}

// ─── NDJSON stream reader ──────────────────────────────────────────────
async function streamLines(res, cb) {
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    parts.filter(Boolean).forEach(line => { try { cb(JSON.parse(line)); } catch {} });
  }
  if (buf.trim()) try { cb(JSON.parse(buf)); } catch {}
}

// ─── Progress helpers ─────────────────────────────────────────────────
function setProgress(pct, label) {
  $('progressBar').style.width  = pct + '%';
  $('progressLabel').textContent = label;
}
function appendLog(line, cls) {
  const log  = $('deployLog');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line + '\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

// ─── FULL DEPLOY SEQUENCE (single button) ──────────────────────────────
async function runFullDeploy() {
  const deployerKey     = $('deployerKey').value.trim();
  const k1Address       = $('k1Address').value.trim();
  const k2Address       = $('k2Address').value.trim();
  const k3Address       = $('k3Address').value.trim();
  const chainId         = $('chainSelect').value;
  const rpcOverride     = $('rpcOverride').value.trim() || null;
  const gasLimitOverride = $('gasLimitOverride').value.trim() || null;
  const k1Key           = $('k1Key').value.trim();

  // ─ Preflight validation ─────────────────────────────────────────────
  const missing = [];
  if (!deployerKey) missing.push('Deployer key');
  if (!k1Address)   missing.push('K1 address');
  if (!k2Address)   missing.push('K2 address');
  if (!k3Address)   missing.push('K3 address');
  if (!chainId)     missing.push('Chain');
  if (missing.length) {
    alert('Cannot deploy — missing: ' + missing.join(', '));
    return;
  }

  const chain = allChains.find(c => c.id === Number(chainId));

  // Show preflight summary
  const rows = [
    ['Chain',        chain ? chain.name + ' (' + chain.id + ')' : chainId],
    ['K1 Address',   k1Address],
    ['K2 Address',   k2Address],
    ['K3 Address',   k3Address],
    ['RPC Override', rpcOverride || 'default'],
    ['Gas Limit',    gasLimitOverride || 'auto'],
    ['Revocations',  revokeItems.length + ' queued'],
  ];
  const pre = $('preflightSummary');
  pre.innerHTML = '<strong>⚠️ Deploying — ' + (chain ? chain.name : chainId) + '</strong><br><br>' +
    rows.map(([k,v]) => '<div class="pf-row"><span class="pf-key">' + k + '</span><span class="pf-val">' + v + '</span></div>').join('');
  show('preflightSummary');

  // Setup log & progress
  $('deployLog').innerHTML = '';
  show('deployLog');
  show('progressWrap');
  $('btnDeploy').disabled = true;
  setProgress(0, 'Starting…');
  audit('=== DEPLOY SEQUENCE START === chain: ' + (chain ? chain.name : chainId));

  try {
    // ── PHASE 1: Gas estimate ──────────────────────────────────────
    appendLog('[►] PHASE 1 — Gas Estimate', 'phase-header');
    setProgress(5, 'Estimating gas…');
    audit('Phase 1: gas estimate');
    try {
      const gas = await fetch('/api/gas/estimate', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ chainId: Number(chainId), rpcOverride })
      }).then(r => r.json());
      if (gas.error) throw new Error(gas.error);
      appendLog('    Gas price : ' + gas.gasPrice, 'log-pass');
      appendLog('    Est. cost : ' + gas.estimatedDeployCost, 'log-pass');
      appendLog('    Block     : ' + gas.blockNumber, 'log-pass');
      setProgress(15, 'Gas OK');
      audit('Gas: ' + gas.estimatedDeployCost, 'log-pass');
    } catch(e) {
      appendLog('    WARNING: gas estimate failed — ' + e.message + ' (continuing)', 'log-warn');
      audit('Gas estimate warning: ' + e.message);
      setProgress(15, 'Gas estimate failed — continuing');
    }

    // ── PHASE 2: Revocation sweep (only if items queued AND k1Key provided) ──
    if (revokeItems.length > 0) {
      if (!k1Key) {
        appendLog('    SKIP: ' + revokeItems.length + ' revocation(s) queued but K1 key not entered — skipping sweep.', 'log-warn');
        audit('Revoke sweep skipped — no K1 key', 'log-warn');
      } else {
        appendLog('[►] PHASE 2 — Revocation Sweep (' + revokeItems.length + ' items)', 'phase-header');
        setProgress(20, 'Running revocations…');
        audit('Phase 2: revocation sweep (' + revokeItems.length + ' items)');
        const revokeLog = $('revokeLog');
        revokeLog.textContent = '';
        show('revokeLog');
        const payload = {
          k1Key, chainId: Number(chainId), rpcOverride,
          erc20Revocations:   revokeItems.filter(r => r.type==='erc20').map(r=>({token:r.token,spender:r.operator})),
          erc721Revocations:  revokeItems.filter(r => r.type==='erc721').map(r=>({token:r.token,operator:r.operator})),
          erc1155Revocations: revokeItems.filter(r => r.type==='erc1155').map(r=>({token:r.token,operator:r.operator})),
          erc777Revocations:  revokeItems.filter(r => r.type==='erc777').map(r=>({token:r.token,operator:r.operator})),
        };
        const rRes = await fetch('/api/revoke', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        await streamLines(rRes, line => {
          const cls = line.status==='REVOKED'?'log-pass':line.status==='FAILED'?'log-fail':'';
          appendLog('    [' + line.status + '] ' + line.message, cls);
          revokeLog.textContent += '[' + line.status + '] ' + line.message + '\n';
          revokeLog.scrollTop = revokeLog.scrollHeight;
          audit('Revoke: ' + line.message, cls);
        });
        setProgress(30, 'Revocations done');
      }
    } else {
      appendLog('[✓] PHASE 2 — No revocations queued, skipping.', 'log-pass');
      setProgress(30, 'No revocations');
    }

    // ── PHASE 3: Deploy ─────────────────────────────────────────────
    appendLog('[►] PHASE 3 — Deploying SecureGate', 'phase-header');
    setProgress(35, 'Deploying…');
    audit('Phase 3: deploy');
    const dRes = await fetch('/api/deploy', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ deployerKey, k1Address, k2Address, k3Address, chainId: Number(chainId), rpcOverride, gasLimitOverride })
    });

    let deployResult = null;
    let deployFailed = false;
    await streamLines(dRes, line => {
      const pct = line.pct ? 35 + Math.round(line.pct * 0.55) : null;
      if (pct) setProgress(pct, line.message || line.status);
      const cls = line.status==='COMPLETE'?'log-pass':line.status==='ERROR'||line.status==='MISMATCH'?'log-fail':'';
      appendLog('    [' + line.status + '] ' + line.message, cls);
      audit('Deploy [' + line.status + ']: ' + line.message, cls);
      if (line.result) {
        deployResult = line.result;
        $('verifyAddress').value = line.result.contractAddress;
        appendLog('\n    ─── DEPLOYMENT RECORD ───', '');
        appendLog(JSON.stringify(line.result, null, 2), 'log-pass');
      }
      if (line.status === 'ERROR' || line.status === 'MISMATCH') deployFailed = true;
    });

    if (deployFailed) {
      setProgress(0, '❌ Deploy failed');
      audit('=== DEPLOY SEQUENCE ABORTED ===', 'log-fail');
      return;
    }

    // ── PHASE 4: Post-deploy verification ──────────────────────────
    if (deployResult) {
      appendLog('[►] PHASE 4 — Post-Deploy Verification', 'phase-header');
      setProgress(93, 'Verifying…');
      audit('Phase 4: post-deploy verification');
      try {
        const vData = await fetch('/api/verify', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            contractAddress: deployResult.contractAddress,
            k1Address, k2Address, k3Address,
            chainId: Number(chainId),
            rpcOverride
          })
        }).then(r => r.json());

        if (vData.error) throw new Error(vData.error);
        vData.checks.forEach(c => {
          const cls = c.pass ? 'log-pass' : 'log-fail';
          appendLog('    ' + (c.pass ? '✓' : '✗') + ' ' + c.name, cls);
          audit('Verify: ' + c.name + ' — ' + (c.pass ? 'PASS' : 'FAIL: ' + c.detail), cls);
        });
        const verdict = vData.summary.failed === 0 ? 'log-pass' : 'log-fail';
        appendLog('\n    VERDICT: ' + vData.summary.verdict, verdict);
        audit('Verdict: ' + vData.summary.verdict, verdict);
        setProgress(100, vData.summary.failed === 0 ? '✅ Gate is Live' : '⚠️ Verify Issues');
      } catch(e) {
        appendLog('    Verification error: ' + e.message, 'log-warn');
        audit('Verify error: ' + e.message, 'log-warn');
        setProgress(100, '⚠️ Verify error');
      }
    } else {
      setProgress(100, '✅ Complete');
    }

    audit('=== DEPLOY SEQUENCE COMPLETE ===', 'log-pass');

  } catch(e) {
    appendLog('FATAL: ' + e.message, 'log-fail');
    setProgress(0, '❌ Fatal error');
    audit('FATAL: ' + e.message, 'log-fail');
  } finally {
    $('btnDeploy').disabled = false;
  }
}

// ─── Standalone verify (Section 5) ──────────────────────────────────
async function runVerify() {
  const contractAddress = $('verifyAddress').value.trim();
  const chainId         = $('chainSelect').value;
  if (!contractAddress || !chainId) { alert('Enter contract address and select chain'); return; }
  hide('verifyResult');
  audit('Verifying ' + contractAddress + ' on chain ' + chainId + '…');
  try {
    const data = await fetch('/api/verify', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        contractAddress,
        k1Address: $('k1Address').value.trim(),
        k2Address: $('k2Address').value.trim(),
        k3Address: $('k3Address').value.trim(),
        chainId:   Number(chainId),
        rpcOverride: $('rpcOverride').value.trim() || null
      })
    }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const el = $('verifyResult');
    el.innerHTML = '';
    const table = document.createElement('div');
    data.checks.forEach(c => {
      const row = document.createElement('div');
      row.className = 'chk-row';
      row.innerHTML = '<span>' + c.name + '</span><span class="' + (c.pass ? 'chk-pass' : 'chk-fail') + '">' + (c.pass ? '✓ PASS' : '✗ FAIL') + '</span>';
      table.appendChild(row);
      if (!c.pass) {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:11px;color:var(--fail);padding:1px 0 5px 10px';
        d.textContent = c.detail;
        table.appendChild(d);
      }
    });
    el.appendChild(table);
    const v = document.createElement('div');
    v.className = 'verdict ' + (data.summary.failed === 0 ? 'pass' : 'fail');
    v.textContent = data.summary.verdict;
    el.appendChild(v);
    show('verifyResult');
    audit('Verify: ' + data.summary.verdict, data.summary.failed === 0 ? 'log-pass' : 'log-fail');
  } catch(e) {
    $('verifyResult').textContent = 'ERROR: ' + e.message;
    show('verifyResult');
    audit('Verify error: ' + e.message, 'log-fail');
  }
}

// ─── Init ───────────────────────────────────────────────────────────────
loadChains().then(() => audit('Dashboard ready — click COMPILE CONTRACT before deploying'));
