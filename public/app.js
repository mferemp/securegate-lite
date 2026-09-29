/* SecureGate Lite v2 — app.js — full blitz sequence */
'use strict';

const $    = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

// ─ Audit ───────────────────────────────────────────────────────────────
let auditLines = [];
function audit(msg, cls) {
  const ts = new Date().toISOString().replace('T',' ').slice(0,19);
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
}

// ─ Phase strip helpers ──────────────────────────────────────────────
let currentPhase = 0;
function setPhase(n, state) {
  if (state === 'active') currentPhase = n;
  const el = $('ph'+n);
  if (!el) return;
  el.classList.remove('active','done','fail');
  if (state) el.classList.add(state);
}
function setProgress(pct, label) {
  $('progressBar').style.width  = Math.min(100, pct) + '%';
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

// ─ NDJSON stream ──────────────────────────────────────────────────
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

// ─ Load chains ─────────────────────────────────────────────────────
let allChains = [];
async function loadChains() {
  try {
    allChains = await fetch('/api/chains').then(r => r.json());
    const sel = $('chainSelect');
    sel.innerHTML = '<option value="">Select chain…</option>';
    allChains.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name + ' (' + c.symbol + ')';
      sel.appendChild(o);
    });
    audit('Loaded ' + allChains.length + ' chains');
  } catch(e) { audit('ERROR loading chains: '+e.message,'log-fail'); }
}

// ─ Compile badge ─────────────────────────────────────────────────
async function runCompile() {
  const badge = $('compileBadge');
  badge.textContent = 'COMPILING…'; badge.style.background='#885500';
  audit('Compiling SecureGate.sol…');
  try {
    const r = await fetch('/api/compile').then(r=>r.json());
    if (!r.ok) throw new Error(r.error);
    badge.textContent = '✓ COMPILED'; badge.classList.add('ok');
    audit('✓ Compiled — ABI entries: '+r.abiEntries+', bytecode: '+r.bytecodeBytes+' bytes','log-pass');
  } catch(e) {
    badge.textContent = '✗ FAILED'; badge.style.background='var(--fail)';
    audit('Compile error: '+e.message,'log-fail');
  }
}

// ─ Gas estimate (standalone) ───────────────────────────────────────
async function runGasEstimate() {
  const chainId = $('chainSelect').value;
  const rpcOverride = $('rpcOverride').value.trim()||null;
  if (!chainId) { alert('Select a chain first'); return; }
  try {
    const data = await fetch('/api/gas/estimate',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chainId:Number(chainId),rpcOverride})
    }).then(r=>r.json());
    if (data.error) throw new Error(data.error);
    $('gasResult').textContent = [
      'Chain  : '+data.chainName,
      'Price  : '+data.gasPrice,
      'BaseFee: '+data.baseFee,
      'Gas    : '+Number(data.estimatedDeployGas).toLocaleString()+' units',
      'Cost   : '+data.estimatedDeployCost,
      'Block  : '+data.blockNumber,
    ].join('\n');
    show('gasResult');
    audit('Gas: '+data.estimatedDeployCost+' on '+data.chainName,'log-pass');
  } catch(e) {
    $('gasResult').textContent='ERROR: '+e.message; show('gasResult');
    audit('Gas error: '+e.message,'log-fail');
  }
}

// ─ Key auto-derive ────────────────────────────────────────────────────
$('deployerKey').addEventListener('input', () => {
  try {
    const w = new ethers.Wallet($('deployerKey').value.trim());
    $('deployerAddress').value = w.address;
  } catch { $('deployerAddress').value = ''; }
});

// ─ THE BLITZ ───────────────────────────────────────────────────────────
async function runBlitz() {
  const deployerKey      = $('deployerKey').value.trim();
  const k1Key            = $('k1Key').value.trim();
  const k1Address        = $('k1Address').value.trim();
  const k2Address        = $('k2Address').value.trim();
  const k3Address        = $('k3Address').value.trim();
  const chainId          = $('chainSelect').value;
  const rpcOverride      = $('rpcOverride').value.trim()||null;
  const gasLimitOverride = $('gasLimitOverride').value.trim()||null;
  const lookbackBlocks   = parseInt($('lookbackBlocks').value)||500000;

  // Preflight check
  const missing = [];
  if (!deployerKey) missing.push('Deployer key');
  if (!k1Address)   missing.push('K1 address');
  if (!k2Address)   missing.push('K2 address');
  if (!k3Address)   missing.push('K3 address');
  if (!chainId)     missing.push('Chain');
  if (missing.length) { alert('Missing: ' + missing.join(', ')); return; }

  const chain = allChains.find(c => c.id === Number(chainId));

  // Preflight summary card
  const rows = [
    ['Chain',         chain ? chain.name+' ('+chain.id+')' : chainId],
    ['K1',            k1Address],
    ['K2',            k2Address],
    ['K3',            k3Address],
    ['RPC',           rpcOverride||'default'],
    ['Gas limit',     gasLimitOverride||'auto'],
    ['Sweep lookback',lookbackBlocks.toLocaleString()+' blocks'],
    ['Flashbots',     chain && chain.id===1 ? 'YES — relay.flashbots.net' : 'N/A — standard RPC'],
  ];
  const pre = $('preflightSummary');
  pre.innerHTML = '<strong>⚠️ Blitz Sequence — ' + (chain?chain.name:chainId) + '</strong><br><br>' +
    rows.map(([k,v])=>'<div class="pf-row"><span class="pf-key">'+k+'</span><span class="pf-val">'+v+'</span></div>').join('');
  show('preflightSummary');

  // UI reset
  $('deployLog').innerHTML = '';
  show('deployLog');
  show('progressWrap');
  show('phaseStrip');
  $('btnDeploy').disabled = true;
  [1,2,3,4,5,6].forEach(n => setPhase(n, ''));
  setProgress(0,'Starting…');
  audit('=== BLITZ START === '+( chain?chain.name:chainId ));

  try {

    // ► PHASE 1 — Compile
    setPhase(1,'active'); setProgress(3,'Compiling…');
    appendLog('[►] PHASE 1 — Compile','phase-header');
    audit('Phase 1: compile');
    try {
      const r = await fetch('/api/compile').then(r=>r.json());
      if (!r.ok) throw new Error(r.error);
      appendLog('    ✓ '+r.bytecodeBytes+' bytes — '+r.abiEntries+' ABI entries','log-pass');
      setPhase(1,'done'); setProgress(10,'Compiled');
      audit('Compiled OK','log-pass');
    } catch(e) {
      appendLog('    WARNING: compile failed — '+e.message+' (using cached artifact if present)','log-warn');
      audit('Compile warning: '+e.message);
      setPhase(1,'fail'); setProgress(10,'Compile warn');
    }

    // ► PHASE 2 — Gas
    setPhase(2,'active'); setProgress(12,'Fetching gas…');
    appendLog('[►] PHASE 2 — Gas Estimate','phase-header');
    audit('Phase 2: gas estimate');
    try {
      const gas = await fetch('/api/gas/estimate',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chainId:Number(chainId),rpcOverride})
      }).then(r=>r.json());
      if (gas.error) throw new Error(gas.error);
      appendLog('    Gas price : '+gas.gasPrice,'log-pass');
      appendLog('    Est. cost : '+gas.estimatedDeployCost,'log-pass');
      appendLog('    Block     : '+gas.blockNumber,'log-pass');
      setPhase(2,'done'); setProgress(18,'Gas OK');
      audit('Gas: '+gas.estimatedDeployCost,'log-pass');
    } catch(e) {
      appendLog('    WARNING: gas estimate failed — '+e.message,'log-warn');
      setPhase(2,'fail'); setProgress(18,'Gas warn');
    }

    // ► PHASE 3 — Auto-sweep K1 approvals
    setPhase(3,'active'); setProgress(20,'Scanning K1 approvals…');
    appendLog('[►] PHASE 3 — On-Chain Approval Sweep (K1: '+k1Address+')','phase-header');
    audit('Phase 3: approval sweep');
    let sweepData = null;
    try {
      sweepData = await fetch('/api/sweep',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({k1Address,chainId:Number(chainId),rpcOverride,lookbackBlocks})
      }).then(r=>r.json());
      if (sweepData.error) throw new Error(sweepData.error);
      const t = sweepData.total;
      appendLog('    Scanned '+sweepData.scannedBlocks.toLocaleString()+' blocks ('+sweepData.fromBlock+'→'+sweepData.toBlock+')','');
      appendLog('    Found '+t+' active permission'+(t===1?'':'s')+' to revoke:', t>0?'log-warn':'log-pass');
      if (sweepData.erc20Revocations.length)   appendLog('      ERC-20 allowances   : '+sweepData.erc20Revocations.length,'log-warn');
      if (sweepData.erc721Revocations.length)  appendLog('      ERC-721/1155 opAll  : '+sweepData.erc721Revocations.length,'log-warn');
      if (sweepData.erc777Revocations.length)  appendLog('      ERC-777 operators   : '+sweepData.erc777Revocations.length,'log-warn');
      setPhase(3,'done'); setProgress(35,'Sweep done — '+t+' found');
      audit('Sweep complete: '+t+' permissions found', t>0?'log-warn':'log-pass');
    } catch(e) {
      appendLog('    WARNING: sweep failed — '+e.message+' (skipping revoke phase)','log-warn');
      setPhase(3,'fail'); setProgress(35,'Sweep error');
      audit('Sweep error: '+e.message,'log-warn');
    }

    // ► PHASE 4 — Revoke everything found
    if (sweepData && sweepData.total > 0) {
      if (!k1Key) {
        appendLog('[⚠️] PHASE 4 — '+sweepData.total+' permission(s) found but K1 key not entered — SKIPPING REVOCATIONS','log-warn');
        appendLog('    Enter K1 Private Key in Section 1 to enable auto-revoke.','log-warn');
        setPhase(4,'fail'); setProgress(50,'K1 key missing — revoke skipped');
        audit('REVOKE SKIPPED — no K1 key','log-warn');
      } else {
        setPhase(4,'active'); setProgress(38,'Revoking '+sweepData.total+' permissions…');
        appendLog('[►] PHASE 4 — Revoking '+sweepData.total+' permission(s)','phase-header');
        audit('Phase 4: revoking '+sweepData.total+' permissions');
        const rRes = await fetch('/api/revoke',{
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            k1Key, chainId:Number(chainId), rpcOverride,
            erc20Revocations:   sweepData.erc20Revocations,
            erc721Revocations:  sweepData.erc721Revocations,
            erc1155Revocations: sweepData.erc1155Revocations,
            erc777Revocations:  sweepData.erc777Revocations,
          })
        });
        let revokeFailed = 0;
        await streamLines(rRes, line => {
          const cls = line.status==='REVOKED'?'log-pass':line.status==='FAILED'?'log-fail':'';
          appendLog('    ['+line.status+'] '+(line.message||'')+(line.results?'\n    Done: '+line.message:''), cls);
          audit('Revoke: '+(line.message||line.status), cls);
          if (line.status==='FAILED') revokeFailed++;
        });
        setPhase(4, revokeFailed===0?'done':'fail');
        setProgress(50,'Revoke done'+(revokeFailed?' ('+revokeFailed+' failed)':''));
      }
    } else {
      appendLog('[✓] PHASE 4 — No active permissions found. K1 is clean.','log-pass');
      setPhase(4,'done'); setProgress(50,'K1 clean');
      audit('K1 has no outstanding permissions','log-pass');
    }

    // ► PHASE 5 — Deploy (Flashbots / standard + retry)
    setPhase(5,'active'); setProgress(52,'Deploying…');
    appendLog('[►] PHASE 5 — Deploy SecureGate','phase-header');
    audit('Phase 5: deploy');
    const dRes = await fetch('/api/deploy',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({deployerKey,k1Address,k2Address,k3Address,chainId:Number(chainId),rpcOverride,gasLimitOverride})
    });
    let deployResult = null;
    let deployFailed = false;
    await streamLines(dRes, line => {
      const pct = line.pct ? 52 + Math.round(line.pct * 0.38) : null;
      if (pct) setProgress(pct, line.message||line.status);
      const cls = line.status==='COMPLETE'?'log-pass':line.status==='ERROR'||line.status==='MISMATCH'?'log-fail':line.status==='RETRY'||line.status==='FLASHBOTS'?'log-warn':'';
      appendLog('    ['+line.status+'] '+(line.message||''), cls);
      audit('Deploy ['+line.status+']: '+(line.message||''), cls);
      if (line.result) {
        deployResult = line.result;
        $('verifyAddress').value = line.result.contractAddress;
        appendLog('\n    ── DEPLOYMENT RECORD ──', '');
        appendLog(JSON.stringify(line.result, null, 2),'log-pass');
      }
      if (line.status==='ERROR'||line.status==='MISMATCH') deployFailed=true;
    });

    if (deployFailed) {
      setPhase(5,'fail'); setProgress(0,'❌ Deploy failed');
      audit('=== BLITZ ABORTED — deploy failed ===','log-fail');
      return;
    }
    setPhase(5,'done');

    // ► PHASE 6 — On-chain verification
    setPhase(6,'active'); setProgress(92,'Verifying…');
    appendLog('[►] PHASE 6 — On-Chain Verification','phase-header');
    audit('Phase 6: verification');
    if (deployResult) {
      try {
        const vData = await fetch('/api/verify',{
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            contractAddress:deployResult.contractAddress,
            k1Address,k2Address,k3Address,
            chainId:Number(chainId),rpcOverride
          })
        }).then(r=>r.json());
        if (vData.error) throw new Error(vData.error);
        vData.checks.forEach(c => {
          appendLog('    '+(c.pass?'✓':'✗')+' '+c.name, c.pass?'log-pass':'log-fail');
          audit('Verify: '+c.name+' — '+(c.pass?'PASS':'FAIL: '+c.detail), c.pass?'log-pass':'log-fail');
        });
        const ok = vData.summary.failed===0;
        appendLog('\n    VERDICT: '+vData.summary.verdict, ok?'log-pass':'log-fail');
        setPhase(6, ok?'done':'fail');
        setProgress(100, ok?'✅ Gate is Live':'⚠️ Verify issues');
        audit('Verdict: '+vData.summary.verdict, ok?'log-pass':'log-fail');
      } catch(e) {
        appendLog('    Verify error: '+e.message,'log-warn');
        setPhase(6,'fail'); setProgress(100,'⚠️ Verify error');
        audit('Verify error: '+e.message,'log-warn');
      }
    } else {
      setPhase(6,'done'); setProgress(100,'✅ Complete');
    }

    audit('=== BLITZ COMPLETE ===','log-pass');

  } catch(e) {
    appendLog('FATAL: '+e.message,'log-fail');
    setProgress(0,'❌ Fatal');
    audit('FATAL: '+e.message,'log-fail');
  } finally {
    $('btnDeploy').disabled = false;
  }
}

// ─ Standalone verify ─────────────────────────────────────────────────
async function runVerify() {
  const contractAddress = $('verifyAddress').value.trim();
  const chainId = $('chainSelect').value;
  if (!contractAddress||!chainId) { alert('Enter contract address and select chain'); return; }
  hide('verifyResult');
  audit('Verifying '+contractAddress+' on chain '+chainId+'…');
  try {
    const data = await fetch('/api/verify',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        contractAddress,
        k1Address:$('k1Address').value.trim(),
        k2Address:$('k2Address').value.trim(),
        k3Address:$('k3Address').value.trim(),
        chainId:Number(chainId),
        rpcOverride:$('rpcOverride').value.trim()||null
      })
    }).then(r=>r.json());
    if (data.error) throw new Error(data.error);
    const el = $('verifyResult');
    el.innerHTML='';
    const table = document.createElement('div');
    data.checks.forEach(c => {
      const row = document.createElement('div');
      row.className='chk-row';
      row.innerHTML='<span>'+c.name+'</span><span class="'+(c.pass?'chk-pass':'chk-fail')+'">'+(c.pass?'✓ PASS':'✗ FAIL')+'</span>';
      table.appendChild(row);
      if (!c.pass) {
        const d=document.createElement('div');
        d.style.cssText='font-size:11px;color:var(--fail);padding:1px 0 5px 10px';
        d.textContent=c.detail; table.appendChild(d);
      }
    });
    el.appendChild(table);
    const v=document.createElement('div');
    v.className='verdict '+(data.summary.failed===0?'pass':'fail');
    v.textContent=data.summary.verdict;
    el.appendChild(v);
    show('verifyResult');
    audit('Verdict: '+data.summary.verdict, data.summary.failed===0?'log-pass':'log-fail');
  } catch(e) {
    $('verifyResult').textContent='ERROR: '+e.message;
    show('verifyResult');
    audit('Verify error: '+e.message,'log-fail');
  }
}

// ─ ethers shim (browser) ─────────────────────────────────────────────
// ethers is not available in the browser bundle — we only use it for key derivation
// Load it from CDN just for the deployer address auto-derive
const ethersScript = document.createElement('script');
ethersScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.1/ethers.umd.min.js';
ethersScript.onload = () => { window.ethers = ethers; };
document.head.appendChild(ethersScript);

// ─ Init ───────────────────────────────────────────────────────────────
loadChains().then(() => audit('Dashboard ready — v2 blitz mode'));
