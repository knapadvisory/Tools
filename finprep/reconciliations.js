/* Reconciliations — GST & TDS vs books. Consolidated audit working paper.
   Pulls candidate book figures from Tally (via /api/fin/trialbalance), sits them
   beside portal/return figures, computes differences with materiality → review points. */
(function(){
'use strict';
var $=function(s){return document.querySelector(s);};
function r2(n){ return Math.round((+n||0)*100)/100; }
function esc(v){ return String(v==null?'':v).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function money(n){ if(n==null||n==='')return ''; return (+n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fy(){ return {start:$('#fyStart').value, end:$('#fyEnd').value}; }

/* the standard reconciliations (all: books vs return/portal) */
var RECO=[
  {key:'turn', label:'Turnover / outward supplies', portalLabel:'GSTR-1 taxable value'},
  {key:'out',  label:'Output GST (CGST+SGST+IGST)', portalLabel:'GSTR-3B tax'},
  {key:'itc',  label:'Input Tax Credit (ITC)', portalLabel:'GSTR-2B ITC available'},
  {key:'tdsr', label:'TDS receivable (credit)', portalLabel:'Form 26AS TDS credited'},
  {key:'tdsp', label:'TDS deducted (payable)', portalLabel:'26Q TDS deducted'}
];
var data={}; // key -> {books, portal, note}
RECO.forEach(function(r){ data[r.key]={books:'',portal:'',note:''}; });

/* ---------------- FY sync ---------------- */
function syncFyStart(){ var e=$('#fyEnd').value; if(!e)return; var d=new Date(e); var s=new Date(Date.UTC(d.getUTCFullYear()-1,d.getUTCMonth(),d.getUTCDate()+1)); $('#fyStart').value=s.toISOString().slice(0,10); }
$('#fyEnd').addEventListener('change',function(){ syncFyStart(); load(); render(); });
$('#company').addEventListener('change',function(){ load(); render(); });
['#matAbs','#matPct'].forEach(function(s){ $(s).addEventListener('input',render); });

/* ---------------- reconciliation table ---------------- */
function threshold(books,portal){ var abs=+$('#matAbs').value||0, pct=(+$('#matPct').value||0)/100; return Math.max(abs, pct*Math.max(Math.abs(books),Math.abs(portal))); }
function statusOf(d){ var b=parseFloat(d.books), p=parseFloat(d.portal); if(isNaN(b)||isNaN(p)) return {s:'',cls:'',diff:null}; var diff=r2(b-p); var t=threshold(b,p); var ad=Math.abs(diff); var cls=ad<=t?'ok':(ad<=3*t?'warn':'bad'); return {s:cls==='ok'?'Matched':(cls==='warn'?'Review':'Material'),cls:cls,diff:diff}; }
function render(){
  var tb=$('#recoRows'); tb.innerHTML='';
  RECO.forEach(function(r){
    var d=data[r.key]; var st=statusOf(d);
    var tr=document.createElement('tr');
    tr.innerHTML='<td class="l"><b>'+r.label+'</b><div class="muted">'+r.portalLabel+'</div></td>'+
      '<td><input type="number" class="num" data-k="books" data-key="'+r.key+'" value="'+esc(d.books)+'"></td>'+
      '<td class="l"><input type="number" class="num" data-k="portal" data-key="'+r.key+'" value="'+esc(d.portal)+'"></td>'+
      '<td class="diff'+(st.diff!=null&&Math.abs(st.diff)>0.005?(st.cls==='ok'?'':' '):'')+'" style="color:'+(st.cls==='bad'?'#b3261e':st.cls==='warn'?'#a86617':'#14461f')+'">'+(st.diff==null?'':money(st.diff))+'</td>'+
      '<td class="l">'+(st.s?'<span class="st '+st.cls+'">'+st.s+'</span>':'<span class="muted">—</span>')+'</td>'+
      '<td class="l"><input data-k="note" data-key="'+r.key+'" value="'+esc(d.note)+'" style="width:180px"></td>';
    tb.appendChild(tr);
  });
  renderFlags(); save();
}
$('#recoRows').addEventListener('input',function(e){ var t=e.target; var key=t.getAttribute('data-key'), k=t.getAttribute('data-k'); if(!key)return; data[key][k]=t.value; if(k==='note'){ save(); } else { render(); } });

function renderFlags(){
  var out=[]; var anyIncomplete=false, anyMaterial=false;
  RECO.forEach(function(r){ var d=data[r.key]; var st=statusOf(d);
    if(st.s===''){ anyIncomplete=true; return; }
    if(st.cls==='ok'){ out.push(['ok', r.label+': ties within materiality (diff '+money(st.diff)+').']); }
    else { anyMaterial=anyMaterial||st.cls==='bad'; out.push([st.cls, r.label+': books '+money(+d.books)+' vs '+r.portalLabel+' '+money(+d.portal)+' → difference '+money(st.diff)+' ('+(st.cls==='bad'?'MATERIAL — explain & adjust':'review')+').']); }
  });
  if(anyIncomplete) out.unshift(['info','Some reconciliations are incomplete — enter both the books and the return/portal figure to evaluate them.']);
  if(!out.length) out.push(['info','Enter figures (or pull from Tally) to build the reconciliation.']);
  $('#flags').innerHTML=out.map(function(f){return '<div class="f '+f[0]+'">'+f[1]+'</div>';}).join('');
}

/* ---------------- persistence ---------------- */
function keyOf(){ return 'knap-reco:'+($('#company').value||'_')+':'+$('#fyEnd').value; }
function save(){ try{ localStorage.setItem(keyOf(), JSON.stringify({company:$('#company').value,fyEnd:$('#fyEnd').value,data:data,matAbs:$('#matAbs').value,matPct:$('#matPct').value})); $('#saveState').textContent='saved '+new Date().toLocaleTimeString(); }catch(e){} }
function load(){ try{ var raw=localStorage.getItem(keyOf()); RECO.forEach(function(r){ data[r.key]={books:'',portal:'',note:''}; }); if(raw){ var d=JSON.parse(raw); if(d.data){ RECO.forEach(function(r){ if(d.data[r.key]) data[r.key]=d.data[r.key]; }); } if(d.matAbs!=null)$('#matAbs').value=d.matAbs; if(d.matPct!=null)$('#matPct').value=d.matPct; } }catch(e){} }

/* ---------------- Tally pull (via local connector) ---------------- */
var API='http://127.0.0.1:8797';
function checkConn(){ var e=$('#conn-ver'); if(!e)return; fetch(API+'/health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){ window.__cv=h.version||''; e.textContent='Connector v'+(h.version||'?')+' · running'; e.style.color='#1b6a3a'; }).catch(function(){ e.textContent='Connector not reachable — open this page on the Tally PC.'; e.style.color='#b42318'; }); }
function updateConnector(){ var el=$('#conn-upd'); if(!el)return; var was=window.__cv||''; el.disabled=true; el.textContent='⏳ Updating…'; fetch(API+'/update',{method:'POST'}).then(function(resp){ if(!resp.ok){ el.disabled=false; el.textContent='⟳ Update connector'; return; } var tries=0,t=setInterval(function(){ tries++; fetch(API+'/health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){ if(h.version&&h.version!==was){ clearInterval(t); el.disabled=false; el.textContent='⟳ Update connector'; checkConn(); } }).catch(function(){}); if(tries>30){ clearInterval(t); el.disabled=false; el.textContent='⟳ Update connector'; checkConn(); } },1000); }).catch(function(){ el.disabled=false; el.textContent='⟳ Update connector'; }); }

function pull(){
  var btn=$('#pull'); var was=btn.textContent; btn.disabled=true; btn.textContent='⏳ Reading Tally…'; $('#pullOut').textContent='';
  fetch(API+'/api/fin/trialbalance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:$('#fyStart').value,to:$('#fyEnd').value,company:$('#tcompany').value||undefined})})
    .then(function(r){return r.json();}).then(function(d){ btn.disabled=false; btn.textContent=was;
      if(!d.ok){ $('#pullOut').textContent=d.error||'Failed to read Tally.'; $('#pullOut').style.color='#b42318'; return; }
      buildBuckets(d.ledgers||[]);
      $('#pullOut').innerHTML='Read <b>'+(d.ledgers||[]).length+'</b> ledgers · trial balance ties to '+money(d.tieCurrent||0)+'. Pick a figure to drop into the reconciliation.'; $('#pullOut').style.color='#14461f';
    }).catch(function(e){ btn.disabled=false; btn.textContent=was; $('#pullOut').textContent='Could not reach the connector — open this page ON the Tally computer, connector running. ('+e.message+')'; $('#pullOut').style.color='#b42318'; });
}
function classify(ledgers){
  var b={sales:[],out:[],itc:[],tdsr:[],tdsp:[]};
  ledgers.forEach(function(l){ var n=(l.name||'').toLowerCase(); var mv=r2((l.current||0)-(l.prior||0)); var it={name:l.name,closing:l.current||0,movement:mv,group:l.group||''};
    if(/(output).*(cgst|sgst|igst|gst)|(cgst|sgst|igst).*output|output tax|out(put)?[ _-]?(cgst|sgst|igst)/.test(n)) b.out.push(it);
    else if(/(input).*(cgst|sgst|igst|gst)|(cgst|sgst|igst).*input|\bitc\b|input tax credit/.test(n)) b.itc.push(it);
    else if(/tds receiv|tds recover|tcs receiv|tds refund|tds \(as/.test(n)) b.tdsr.push(it);
    else if((/tds|194[a-z]?\b/.test(n)) && /payab|deduct|on (contract|profession|rent|commission|interest|salar)/.test(n) && !/receiv|recover/.test(n)) b.tdsp.push(it);
    else if(l.isRevenue && /sale|revenue|turnover|service|fees|receipt|income from op|contract receipt|professional (fee|charge)/.test(n)) b.sales.push(it);
  });
  return b;
}
var BKTS=[
  {k:'sales',key:'turn',title:'Turnover (sales ledgers)',use:'movement',reliable:true},
  {k:'out',  key:'out', title:'Output GST ledgers',use:'movement',reliable:false},
  {k:'itc',  key:'itc', title:'Input GST / ITC ledgers',use:'movement',reliable:false},
  {k:'tdsr', key:'tdsr',title:'TDS receivable ledgers',use:'movement',reliable:false},
  {k:'tdsp', key:'tdsp',title:'TDS payable / deducted',use:'movement',reliable:false}
];
function buildBuckets(ledgers){
  var b=classify(ledgers); var host=$('#buckets'); host.innerHTML='';
  BKTS.forEach(function(spec){ var items=b[spec.k]||[]; var totMv=r2(items.reduce(function(s,x){return s+Math.abs(x.movement);},0)); var totCl=r2(items.reduce(function(s,x){return s+Math.abs(x.closing);},0));
    var div=document.createElement('div'); div.className='bkt';
    div.innerHTML='<h3>'+spec.title+' <span class="muted">('+items.length+')</span></h3>'+
      '<div class="tot">'+money(totMv)+' <span class="muted" style="font-size:12px">year movement</span></div>'+
      '<div class="muted">closing '+money(totCl)+(spec.reliable?'':' · net movement may understate gross — verify with the detail tool')+'</div>'+
      '<div style="margin-top:6px"><button class="btn ghost sm" data-fill="'+spec.key+'" data-val="'+totMv+'">Use as books</button></div>'+
      (items.length?'<ul>'+items.map(function(x){return '<li>'+esc(x.name)+' · mv '+money(x.movement)+' · cl '+money(x.closing)+'</li>';}).join('')+'</ul>':'<div class="muted" style="margin-top:6px">No matching ledgers.</div>');
    host.appendChild(div);
  });
}
$('#buckets').addEventListener('click',function(e){ var btn=e.target.closest('button[data-fill]'); if(!btn)return; var key=btn.getAttribute('data-fill'); data[key].books=btn.getAttribute('data-val'); render(); });

/* ---------------- export ---------------- */
$('#exportBtn').addEventListener('click',function(){
  if(!window.ExcelJS){ alert('Excel library still loading — try again.'); return; }
  var wb=new ExcelJS.Workbook(); var ws=wb.addWorksheet('Reconciliations');
  ws.addRow([($('#company').value||'Company')+' — Reconciliation statement']); ws.getRow(1).font={bold:true,size:13};
  ws.addRow(['FY ended '+$('#fyEnd').value+' · materiality ₹'+$('#matAbs').value+' / '+$('#matPct').value+'%']); ws.addRow([]);
  ws.addRow(['Reconciliation','As per books','As per return/portal','Difference','Status','Auditor remark']); ws.getRow(4).font={bold:true};
  RECO.forEach(function(r){ var d=data[r.key]; var st=statusOf(d); ws.addRow([r.label+' ('+r.portalLabel+')', d.books===''?'':+d.books, d.portal===''?'':+d.portal, st.diff==null?'':st.diff, st.s||'', d.note||'']); });
  ws.columns.forEach(function(c,i){ c.width=i===0?46:(i===5?32:16); });
  wb.xlsx.writeBuffer().then(function(buf){ var blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}); var u=URL.createObjectURL(blob),a=document.createElement('a'); a.href=u; a.download='Reconciliations-'+(($('#company').value||'company').replace(/[^\w]+/g,'-'))+'-'+$('#fyEnd').value+'.xlsx'; document.body.appendChild(a); a.click(); setTimeout(function(){a.remove();URL.revokeObjectURL(u);},1500); });
});

$('#pull').addEventListener('click',pull);
$('#conn-upd').addEventListener('click',updateConnector);

/* ---------------- boot ---------------- */
syncFyStart(); load(); render(); checkConn();
})();
