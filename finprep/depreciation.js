/* Fixed Assets & Depreciation — Schedule II (Companies Act 2013).
   Pure engine (computeAsset) is validated separately; UI + Excel + note here. */
(function(){
'use strict';
var $=function(s){return document.querySelector(s);};

/* Schedule II, Part C — common useful lives (years). "Custom" lets you type one. */
var CLASSES=[
  {label:'Building — RCC frame', life:60},
  {label:'Building — other than RCC', life:30},
  {label:'Building — temporary structures', life:3},
  {label:'Plant & Machinery — general', life:15},
  {label:'Plant & Machinery — continuous process', life:25},
  {label:'Furniture & Fittings — general', life:10},
  {label:'Furniture & Fittings — hotels/restaurants', life:8},
  {label:'Office Equipment', life:5},
  {label:'Computers — end-user (laptop/desktop)', life:3},
  {label:'Computers — servers & networks', life:6},
  {label:'Electrical Installations & Equipment', life:10},
  {label:'Motor Vehicle — car (non-commercial)', life:8},
  {label:'Motor Vehicle — commercial (bus/lorry/taxi)', life:6},
  {label:'Motor Cycle / Scooter', life:10},
  {label:'Laboratory Equipment — general', life:10},
  {label:'Intangible / Software (AS 26)', life:5},
  {label:'Custom', life:0}
];

/* ---------------- engine ---------------- */
function r2(n){ return Math.round((+n||0)*100)/100; }
function days(a,b){ return Math.round((Date.parse(b)-Date.parse(a))/86400000); }
function computeAsset(a, fy){
  var cost=+a.cost||0, life=+a.life||0, resPct=(a.resPct==null||a.resPct===''?5:+a.resPct);
  var residual=cost*resPct/100, depBase=Math.max(0,cost-residual);
  var S=fy.start,E=fy.end,D=a.dateInUse||S;
  var addedThisYear=Date.parse(D)>=Date.parse(S);
  var openGross=addedThisYear?0:cost;
  var openAccum=addedThisYear?0:(+a.openAccum||0);
  var bookValue=cost-openAccum;
  var disposed=!!(a.disposalDate&&Date.parse(a.disposalDate)>=Date.parse(S)&&Date.parse(a.disposalDate)<=Date.parse(E));
  var holdStart=Math.max(Date.parse(D),Date.parse(S));
  var holdEnd=disposed?Date.parse(a.disposalDate):Date.parse(E);
  var yearDays=days(S,E)+1;
  var daysHeld=Math.min(Math.max(0,Math.round((holdEnd-holdStart)/86400000)+1),yearDays);
  var maxDep=Math.max(0,bookValue-residual);
  var dep=0;
  if(cost>0&&life>0){
    if(a.method==='SLM'){ dep=(depBase/life)*(daysHeld/yearDays); }
    else { var ratio=residual>0?residual/cost:0.05; var r=1-Math.pow(ratio,1/life); dep=bookValue*r*(daysHeld/yearDays); }
    dep=Math.max(0,Math.min(dep,maxDep));
  }
  var depForYear=r2(dep);
  var additions=addedThisYear?cost:0, deletionsGross=disposed?cost:0;
  var closeGross=openGross+additions-deletionsGross;
  var accumRemoved=disposed?(openAccum+depForYear):0;
  var closeAccum=openAccum+depForYear-accumRemoved;
  var wdvAtDisposal=disposed?r2(bookValue-depForYear):null;
  var profitLoss=disposed?r2((+a.proceeds||0)-wdvAtDisposal):null;
  return {openGross:r2(openGross),openAccum:r2(openAccum),openNet:r2(openGross-openAccum),
    additions:r2(additions),deletionsGross:r2(deletionsGross),depForYear:depForYear,
    depOnDeletion:r2(accumRemoved), closeGross:r2(closeGross),closeAccum:r2(closeAccum),
    closeWDV:r2(closeGross-closeAccum),disposed:disposed,wdvAtDisposal:wdvAtDisposal,
    profitLoss:profitLoss,daysHeld:daysHeld,yearDays:yearDays,residual:r2(residual),bookValue:r2(bookValue)};
}

/* ---------------- state ---------------- */
var rows=[]; // asset input objects
function fy(){ return {start:$('#fyStart').value, end:$('#fyEnd').value}; }
function classLife(label){ var c=CLASSES.find(function(x){return x.label===label;}); return c?c.life:0; }
function blankRow(){ return {desc:'',cls:'Computers — end-user (laptop/desktop)',life:3,method:$('#defMethod').value,resPct:$('#defRes').value,dateInUse:'',cost:'',openAccum:'',disposalDate:'',proceeds:''}; }
function money(n){ if(n==null||n==='')return ''; return (+n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }

/* ---------------- FY sync ---------------- */
function syncFyStart(){ var e=$('#fyEnd').value; if(!e){return;} var d=new Date(e); var s=new Date(Date.UTC(d.getUTCFullYear()-1,d.getUTCMonth(),d.getUTCDate()+1)); $('#fyStart').value=s.toISOString().slice(0,10); }
$('#fyEnd').addEventListener('change',function(){ syncFyStart(); load(); render(); });

/* ---------------- render ---------------- */
function render(){
  var tb=$('#rows'); tb.innerHTML='';
  var F=fy();
  var tot={openGross:0,openAccum:0,additions:0,depForYear:0,deletionsGross:0,depOnDeletion:0,closeGross:0,closeAccum:0,closeWDV:0,profitLoss:0};
  rows.forEach(function(a,i){
    var c=computeAsset(a,F);
    var tr=document.createElement('tr'); if(c.disposed) tr.className='disp';
    tr.innerHTML=
      '<td class="l">'+(i+1)+'</td>'+
      '<td class="l desc"><input value="'+esc(a.desc)+'" data-k="desc" data-i="'+i+'"></td>'+
      '<td class="l">'+clsSelect(a.cls,i)+'</td>'+
      '<td><input type="number" value="'+esc(a.life)+'" data-k="life" data-i="'+i+'" style="width:60px"></td>'+
      '<td>'+methodSelect(a.method,i)+'</td>'+
      '<td><input type="number" value="'+esc(a.resPct)+'" data-k="resPct" data-i="'+i+'" style="width:56px"></td>'+
      '<td class="l"><input type="date" value="'+esc(a.dateInUse)+'" data-k="dateInUse" data-i="'+i+'"></td>'+
      '<td><input type="number" value="'+esc(a.cost)+'" data-k="cost" data-i="'+i+'" style="width:100px"></td>'+
      '<td><input type="number" value="'+esc(a.openAccum)+'" data-k="openAccum" data-i="'+i+'" style="width:100px"></td>'+
      '<td class="l"><input type="date" value="'+esc(a.disposalDate)+'" data-k="disposalDate" data-i="'+i+'"></td>'+
      '<td><input type="number" value="'+esc(a.proceeds)+'" data-k="proceeds" data-i="'+i+'" style="width:96px"></td>'+
      '<td class="calc num">'+money(c.openNet)+'</td>'+
      '<td class="calc num">'+money(c.additions)+'</td>'+
      '<td class="calc num">'+money(c.depForYear)+'</td>'+
      '<td class="calc num">'+money(c.disposed?c.wdvAtDisposal:0)+'</td>'+
      '<td class="calc num">'+money(c.closeWDV)+'</td>'+
      '<td class="calc num'+(c.profitLoss!=null&&c.profitLoss<0?' neg':'')+'">'+(c.profitLoss==null?'':money(c.profitLoss))+'</td>'+
      '<td><button class="del" data-del="'+i+'" title="Remove">✕</button></td>';
    tb.appendChild(tr);
    tot.openGross+=c.openGross; tot.openAccum+=c.openAccum; tot.additions+=c.additions; tot.depForYear+=c.depForYear;
    tot.deletionsGross+=c.deletionsGross; tot.depOnDeletion+=c.depOnDeletion; tot.closeGross+=c.closeGross;
    tot.closeAccum+=c.closeAccum; tot.closeWDV+=c.closeWDV; tot.profitLoss+=(c.profitLoss||0);
  });
  $('#foot').innerHTML='<td></td><td class="l">Total ('+rows.length+' assets)</td><td colspan="9" class="l muted">pro-rata by days · residual capped</td>'+
    '<td class="calc num">'+money(r2(tot.openGross-tot.openAccum))+'</td>'+
    '<td class="calc num">'+money(r2(tot.additions))+'</td>'+
    '<td class="calc num">'+money(r2(tot.depForYear))+'</td>'+
    '<td class="calc num">'+money(r2(tot.depOnDeletion))+'</td>'+
    '<td class="calc num">'+money(r2(tot.closeWDV))+'</td>'+
    '<td class="calc num'+(tot.profitLoss<0?' neg':'')+'">'+money(r2(tot.profitLoss))+'</td><td></td>';
  renderNote(F); renderFlags(F); save();
}
function esc(v){ return String(v==null?'':v).replace(/"/g,'&quot;'); }
function clsSelect(val,i){ return '<select data-k="cls" data-i="'+i+'">'+CLASSES.map(function(c){return '<option'+(c.label===val?' selected':'')+'>'+c.label+'</option>';}).join('')+'</select>'; }
function methodSelect(val,i){ return '<select data-k="method" data-i="'+i+'"><option'+(val==='WDV'?' selected':'')+'>WDV</option><option'+(val==='SLM'?' selected':'')+'>SLM</option></select>'; }

/* delegated input handling */
$('#rows').addEventListener('input',onEdit);
$('#rows').addEventListener('change',onEdit);
function onEdit(e){
  var t=e.target; var i=t.getAttribute('data-i'), k=t.getAttribute('data-k');
  if(i==null||k==null){ var d=t.getAttribute('data-del'); if(d!=null){ rows.splice(+d,1); render(); } return; }
  i=+i; rows[i][k]=t.value;
  if(k==='cls'){ var life=classLife(t.value); if(life>0){ rows[i].life=life; } render(); return; }
  // light-touch: recompute calc cells without full re-render would be nicer, but re-render keeps it simple & correct
  if(k==='cost'||k==='life'||k==='resPct'||k==='method'||k==='dateInUse'||k==='openAccum'||k==='disposalDate'||k==='proceeds'){ render(); }
  else { save(); }
}

/* ---------------- PPE note (block-wise by class) ---------------- */
function renderNote(F){
  var blocks={};
  rows.forEach(function(a){ var c=computeAsset(a,F); var key=a.cls||'Unclassified';
    var b=blocks[key]||(blocks[key]={openGross:0,additions:0,deletionsGross:0,closeGross:0,openAccum:0,depForYear:0,depOnDeletion:0,closeAccum:0});
    b.openGross+=c.openGross; b.additions+=c.additions; b.deletionsGross+=c.deletionsGross; b.closeGross+=c.closeGross;
    b.openAccum+=c.openAccum; b.depForYear+=c.depForYear; b.depOnDeletion+=c.depOnDeletion; b.closeAccum+=c.closeAccum;
  });
  var keys=Object.keys(blocks); var T={openGross:0,additions:0,deletionsGross:0,closeGross:0,openAccum:0,depForYear:0,depOnDeletion:0,closeAccum:0};
  var body=keys.map(function(k){ var b=blocks[k];
    ['openGross','additions','deletionsGross','closeGross','openAccum','depForYear','depOnDeletion','closeAccum'].forEach(function(f){T[f]+=b[f];});
    var netClose=r2(b.closeGross-b.closeAccum), netOpen=r2(b.openGross-b.openAccum);
    return '<tr><td class="l">'+k+'</td>'+cells([b.openGross,b.additions,b.deletionsGross,b.closeGross,b.openAccum,b.depForYear,b.depOnDeletion,b.closeAccum,netClose,netOpen])+'</tr>';
  }).join('');
  var netCloseT=r2(T.closeGross-T.closeAccum), netOpenT=r2(T.openGross-T.openAccum);
  var html='<table class="note-tbl"><thead>'+
    '<tr><th class="l" rowspan="2">Block of assets</th><th colspan="4">Gross block</th><th colspan="4">Depreciation</th><th colspan="2">Net block</th></tr>'+
    '<tr><th>Opening</th><th>Additions</th><th>Deletions</th><th>Closing</th><th>Opening</th><th>For the year</th><th>On deletions</th><th>Closing</th><th>As at '+fmt(F.end)+'</th><th>As at '+fmt(F.start)+'</th></tr>'+
    '</thead><tbody>'+(body||'<tr><td class="l muted" colspan="11">No assets yet.</td></tr>')+'</tbody>'+
    '<tfoot><tr><td class="l">Total</td>'+cells([T.openGross,T.additions,T.deletionsGross,T.closeGross,T.openAccum,T.depForYear,T.depOnDeletion,T.closeAccum,netCloseT,netOpenT])+'</tr></tfoot></table>';
  $('#note').innerHTML=html;
  // KPIs
  var plTot=r2(rows.reduce(function(s,a){var c=computeAsset(a,F);return s+(c.profitLoss||0);},0));
  $('#kpi').innerHTML=
    kpi('Depreciation for the year', money(r2(T.depForYear)), 'to Statement of P&L')+
    kpi('Net block (closing)', money(netCloseT), 'as at '+fmt(F.end))+
    kpi('Additions in year', money(r2(T.additions)), '')+
    kpi('Profit/(loss) on sale', money(plTot), plTot<0?'loss':'gain');
}
function cells(arr){ return arr.map(function(n){ return '<td class="num'+(n<0?' neg':'')+'">'+money(r2(n))+'</td>'; }).join(''); }
function kpi(t,v,s){ return '<div class="k"><div class="v num">'+v+'</div><div class="t">'+t+(s?' · '+s:'')+'</div></div>'; }

/* ---------------- review flags ---------------- */
function renderFlags(F){
  var out=[];
  rows.forEach(function(a,i){
    var c=computeAsset(a,F); var name=a.desc||('Asset '+(i+1));
    if(+a.cost>0 && !a.dateInUse) out.push(['bad', name+': no “date in use” — depreciation can’t be pro-rated.']);
    if(a.cls==='Custom') out.push(['warn', name+': custom useful life ('+(a.life||'?')+' yrs) — record technical justification & disclose.']);
    if(!a.cls||classLife(a.cls)>0 && +a.life && +a.life!==classLife(a.cls) && a.cls!=='Custom') out.push(['warn', name+': life '+a.life+'y differs from Schedule II ('+classLife(a.cls)+'y for '+a.cls+') — justify.']);
    if(+a.openAccum>+a.cost && +a.cost>0) out.push(['bad', name+': opening accumulated depreciation exceeds cost.']);
    if(c.closeWDV<-0.5) out.push(['bad', name+': closing WDV is negative ('+money(c.closeWDV)+').']);
    if(+a.resPct===0 && a.method==='WDV' && +a.cost>0) out.push(['warn', name+': WDV with 0% residual — a nominal 5% is assumed so the rate stays finite.']);
    if(c.disposed) out.push([c.profitLoss<0?'info':'info', name+': disposed on '+fmt(a.disposalDate)+' — WDV '+money(c.wdvAtDisposal)+', proceeds '+money(+a.proceeds||0)+' → '+(c.profitLoss<0?'loss ':'gain ')+money(Math.abs(c.profitLoss))+'.']);
    if(!c.disposed && c.depForYear===0 && +a.cost>0 && c.closeWDV<=c.residual+0.5) out.push(['ok', name+': fully depreciated — carried at residual '+money(c.residual)+'.']);
  });
  if(!rows.length) out.push(['info','Add assets (or load the sample / import Excel) to see the schedule and review points.']);
  else if(!out.length) out.push(['ok','No exceptions flagged. Still verify additions to bills and physical existence of assets.']);
  $('#flags').innerHTML=out.map(function(f){return '<div class="f '+f[0]+'">'+f[1]+'</div>';}).join('');
}

/* ---------------- persistence (per company + FY, in this browser) ---------------- */
function keyOf(){ return 'knap-dep:'+($('#company').value||'_')+':'+$('#fyEnd').value; }
function save(){ try{ localStorage.setItem(keyOf(), JSON.stringify({company:$('#company').value,fyEnd:$('#fyEnd').value,rows:rows})); $('#saveState').textContent='saved '+new Date().toLocaleTimeString(); }catch(e){} }
function load(){ try{ var raw=localStorage.getItem(keyOf()); if(raw){ var d=JSON.parse(raw); rows=d.rows||[]; } else { rows=[]; } }catch(e){ rows=[]; } }
$('#company').addEventListener('change',function(){ load(); render(); });

/* ---------------- toolbar ---------------- */
$('#add').addEventListener('click',function(){ rows.push(blankRow()); render(); });
$('#clear').addEventListener('click',function(){ if(confirm('Clear all assets for this company & year?')){ rows=[]; render(); } });
$('#sample').addEventListener('click',function(){ rows=sampleRows(); render(); });
$('#roll').addEventListener('click',rollForward);
$('#defMethod').addEventListener('change',function(){ rows.forEach(function(a){ if(!a.cost) a.method=$('#defMethod').value; }); });

function rollForward(){
  var F=fy();
  var next=[];
  rows.forEach(function(a){ var c=computeAsset(a,F); if(c.disposed) return; // sold assets drop off
    next.push({desc:a.desc,cls:a.cls,life:a.life,method:a.method,resPct:a.resPct,dateInUse:a.dateInUse,
      cost:a.cost, openAccum:c.closeAccum, disposalDate:'', proceeds:''});
  });
  // advance FY by one year
  var e=new Date($('#fyEnd').value); e.setUTCFullYear(e.getUTCFullYear()+1);
  $('#fyEnd').value=e.toISOString().slice(0,10); syncFyStart();
  rows=next; render();
  alert('Rolled forward. Closing WDV is now opening for '+fmt($('#fyEnd').value)+'. Review, then export.');
}

/* ---------------- sample ---------------- */
function sampleRows(){ return [
  {desc:'Office building',cls:'Building — RCC frame',life:60,method:'SLM',resPct:5,dateInUse:'2019-06-01',cost:5000000,openAccum:520000,disposalDate:'',proceeds:''},
  {desc:'Laptops (5)',cls:'Computers — end-user (laptop/desktop)',life:3,method:'WDV',resPct:5,dateInUse:'2025-07-15',cost:300000,openAccum:'',disposalDate:'',proceeds:''},
  {desc:'Server',cls:'Computers — servers & networks',life:6,method:'WDV',resPct:5,dateInUse:'2023-04-10',cost:450000,openAccum:180000,disposalDate:'',proceeds:''},
  {desc:'Maruti Dzire',cls:'Motor Vehicle — car (non-commercial)',life:8,method:'WDV',resPct:5,dateInUse:'2021-04-01',cost:900000,openAccum:520000,disposalDate:'2025-12-20',proceeds:350000},
  {desc:'Office furniture',cls:'Furniture & Fittings — general',life:10,method:'WDV',resPct:5,dateInUse:'2022-04-01',cost:250000,openAccum:80000,disposalDate:'',proceeds:''}
]; }

/* ---------------- Excel ---------------- */
var IN_COLS=[['Description','desc'],['Asset class','cls'],['Life (yrs)','life'],['Method','method'],['Residual %','resPct'],['Date in use','dateInUse'],['Cost','cost'],['Opening accum. dep','openAccum'],['Disposal date','disposalDate'],['Sale proceeds','proceeds']];
$('#exportBtn').addEventListener('click',exportXlsx);
$('#importBtn').addEventListener('click',function(){ $('#importFile').click(); });
$('#importFile').addEventListener('change',function(){ var f=this.files[0]; this.value=''; if(f) importXlsx(f); });

function exportXlsx(){
  if(!window.ExcelJS){ alert('Excel library still loading — try again in a moment.'); return; }
  var F=fy(); var wb=new ExcelJS.Workbook();
  var ws=wb.addWorksheet('FA Register');
  var head=IN_COLS.map(function(c){return c[0];}).concat(['Opening WDV','Additions','Dep for year','Deletions (WDV)','Closing gross','Closing accum dep','Closing WDV','P/(L) on sale']);
  ws.addRow(head); ws.getRow(1).font={bold:true};
  rows.forEach(function(a){ var c=computeAsset(a,F);
    ws.addRow([a.desc,a.cls,+a.life||'',a.method,(a.resPct===''?'':+a.resPct),a.dateInUse,+a.cost||0,+a.openAccum||0,a.disposalDate,+a.proceeds||0,
      c.openNet,c.additions,c.depForYear,c.disposed?c.wdvAtDisposal:0,c.closeGross,c.closeAccum,c.closeWDV,c.profitLoss==null?'':c.profitLoss]);
  });
  ws.columns.forEach(function(col){ var m=10; col.eachCell(function(cell){ var l=String(cell.value==null?'':cell.value).length; if(l>m)m=l; }); col.width=Math.min(m+2,32); });
  // PPE note sheet
  var ns=wb.addWorksheet('PPE Note');
  ns.addRow(['Block of assets','Gross opening','Additions','Deletions','Gross closing','Dep opening','Dep for year','Dep on deletions','Dep closing','Net closing','Net opening']);
  ns.getRow(1).font={bold:true};
  var blocks={}; rows.forEach(function(a){ var c=computeAsset(a,F); var b=blocks[a.cls]||(blocks[a.cls]={og:0,ad:0,dl:0,cg:0,oa:0,dy:0,dd:0,ca:0}); b.og+=c.openGross;b.ad+=c.additions;b.dl+=c.deletionsGross;b.cg+=c.closeGross;b.oa+=c.openAccum;b.dy+=c.depForYear;b.dd+=c.depOnDeletion;b.ca+=c.closeAccum; });
  Object.keys(blocks).forEach(function(k){ var b=blocks[k]; ns.addRow([k,r2(b.og),r2(b.ad),r2(b.dl),r2(b.cg),r2(b.oa),r2(b.dy),r2(b.dd),r2(b.ca),r2(b.cg-b.ca),r2(b.og-b.oa)]); });
  ns.columns.forEach(function(col){ col.width=16; }); ns.getColumn(1).width=34;
  wb.xlsx.writeBuffer().then(function(buf){ dl(new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), 'Depreciation-'+(($('#company').value||'company').replace(/[^\w]+/g,'-'))+'-'+$('#fyEnd').value+'.xlsx'); });
}
function importXlsx(file){
  if(!window.ExcelJS){ alert('Excel library still loading — try again.'); return; }
  file.arrayBuffer().then(function(buf){ var wb=new ExcelJS.Workbook(); return wb.xlsx.load(buf).then(function(){
    var ws=wb.getWorksheet('FA Register')||wb.worksheets[0]; if(!ws){ alert('No sheet found.'); return; }
    var hdr={}; ws.getRow(1).eachCell(function(cell,c){ hdr[String(cell.value||'').trim().toLowerCase()]=c; });
    function col(name){ return hdr[name.toLowerCase()]; }
    var out=[];
    ws.eachRow(function(row,rn){ if(rn===1)return;
      var get=function(label){ var c=col(label); if(!c)return ''; var v=row.getCell(c).value; if(v&&v.result!=null)v=v.result; if(v instanceof Date)return v.toISOString().slice(0,10); return v==null?'':v; };
      var desc=get('Description'); var cost=get('Cost');
      if((desc===''||desc==null)&&(!cost)) return;
      out.push({desc:String(desc||''),cls:String(get('Asset class')||'Custom'),life:num(get('Life (yrs)')),method:(String(get('Method')||'WDV').toUpperCase().indexOf('SLM')>=0?'SLM':'WDV'),resPct:get('Residual %')===''?5:num(get('Residual %')),dateInUse:dstr(get('Date in use')),cost:num(cost),openAccum:num(get('Opening accum. dep')),disposalDate:dstr(get('Disposal date')),proceeds:num(get('Sale proceeds'))});
    });
    rows=out; render(); alert('Imported '+rows.length+' assets.');
  }); }).catch(function(e){ alert('Import failed: '+e.message); });
}
function num(v){ if(v===''||v==null)return ''; var n=parseFloat(String(v).replace(/[, ]/g,'')); return isNaN(n)?'':n; }
function dstr(v){ if(!v)return ''; if(v instanceof Date)return v.toISOString().slice(0,10); var s=String(v); var m=s.match(/(\d{4})-(\d{2})-(\d{2})/); if(m)return m[0]; var d=new Date(s); return isNaN(d)?'':d.toISOString().slice(0,10); }

/* ---------------- misc ---------------- */
function fmt(iso){ if(!iso)return ''; var d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
function dl(blob,name){ var u=URL.createObjectURL(blob),a=document.createElement('a'); a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){a.remove();URL.revokeObjectURL(u);},1500); }
function refTable(){ $('#refTbl').innerHTML='<table><thead><tr><th>Asset class</th><th>Useful life (yrs)</th></tr></thead><tbody>'+CLASSES.filter(function(c){return c.life>0;}).map(function(c){return '<tr><td>'+c.label+'</td><td>'+c.life+'</td></tr>';}).join('')+'</tbody></table>'; }

/* ---------------- seed from Tally (via local connector) ---------------- */
var API='http://127.0.0.1:8797';
function checkConn(){ var e=$('#conn-ver'); if(!e)return;
  fetch(API+'/health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){ window.__cv=h.version||''; e.textContent='Connector v'+(h.version||'?')+' · running'; e.style.color='#1b6a3a'; }).catch(function(){ e.textContent='Connector not reachable — open this page on the Tally PC.'; e.style.color='#b42318'; }); }
function updateConnector(){ var el=$('#conn-upd'); if(!el)return; var was=window.__cv||''; el.disabled=true; el.textContent='⏳ Updating…';
  fetch(API+'/update',{method:'POST'}).then(function(resp){ if(!resp.ok){ el.disabled=false; el.textContent='⟳ Update connector'; return; }
    var tries=0,t=setInterval(function(){ tries++; fetch(API+'/health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){ if(h.version&&h.version!==was){ clearInterval(t); el.disabled=false; el.textContent='⟳ Update connector'; checkConn(); } }).catch(function(){}); if(tries>30){ clearInterval(t); el.disabled=false; el.textContent='⟳ Update connector'; checkConn(); } },1000);
  }).catch(function(){ el.disabled=false; el.textContent='⟳ Update connector'; }); }
function pullFromTally(){
  var btn=$('#pull'); var was=btn.textContent; btn.disabled=true; btn.textContent='⏳ Reading Tally…'; $('#pullOut').textContent='';
  fetch(API+'/api/fin/fixedassets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:$('#fyStart').value,to:$('#fyEnd').value,company:$('#tcompany').value||undefined})})
    .then(function(r){return r.json();}).then(function(d){ btn.disabled=false; btn.textContent=was;
      if(!d.ok){ $('#pullOut').textContent=d.error||'Failed to read Tally.'; $('#pullOut').style.color='#b42318'; return; }
      seedFromTally(d);
    }).catch(function(e){ btn.disabled=false; btn.textContent=was; $('#pullOut').textContent='Could not reach the connector — open this page ON the Tally computer, with the KNAP connector running. ('+e.message+')'; $('#pullOut').style.color='#b42318'; });
}
function guessClass(text){ text=(text||'').toLowerCase();
  var rules=[[/comput|laptop|desktop|printer|scanner|monitor|keyboard/,'Computers — end-user (laptop/desktop)'],[/server|network|router|firewall|switch\b/,'Computers — servers & networks'],[/car|vehicle|dzire|innova|swift|scorpio|creta|nexon|xuv/,'Motor Vehicle — car (non-commercial)'],[/truck|lorry|\bbus\b|tempo|commercial vehicle/,'Motor Vehicle — commercial (bus/lorry/taxi)'],[/bike|motor ?cycle|scooter|activa|two ?wheeler/,'Motor Cycle / Scooter'],[/furnitur|chair|table|sofa|almirah|cabinet|cupboard|desk\b/,'Furniture & Fittings — general'],[/build|factory|premis|\bshed\b|godown|construction/,'Building — RCC frame'],[/plant|machin|equipment|generator|dg ?set|compressor/,'Plant & Machinery — general'],[/electr|wiring|transformer|\bups\b|inverter|stabiliz/,'Electrical Installations & Equipment'],[/air ?condition|\bac\b|refriger|water ?purif|epabx|projector|office equip/,'Office Equipment'],[/software|licen|\berp\b|tally|website|app\b/,'Intangible / Software (AS 26)']];
  for(var i=0;i<rules.length;i++){ if(rules[i][0].test(text)) return rules[i][1]; }
  return 'Custom';
}
function seedFromTally(d){
  var adds=d.additions||[];
  if(!adds.length){ $('#pullOut').textContent=(d.note||'No fixed-asset additions found in this period.'); $('#pullOut').style.color='#a86617'; }
  else {
    var seen={}; rows.forEach(function(a){ seen[(a.dateInUse||'')+'|'+(a.desc||'')+'|'+(+a.cost||0)]=1; });
    var added=0;
    adds.forEach(function(x){ var desc=(x.narration||x.ledger||'Addition'); var k=(x.date||'')+'|'+desc+'|'+x.amount; if(seen[k])return; seen[k]=1;
      var cls=guessClass(x.ledger+' '+(x.narration||'')); rows.push({desc:desc.slice(0,90),cls:cls,life:classLife(cls),method:$('#defMethod').value,resPct:$('#defRes').value,dateInUse:x.date,cost:x.amount,openAccum:'',disposalDate:'',proceeds:''}); added++; });
    $('#pullOut').innerHTML='Seeded <b>'+added+'</b> addition line(s) from Tally — now set asset class, useful life &amp; method for each (a guess is pre-filled).'; $('#pullOut').style.color='#14461f';
    render();
  }
  renderFaReview(d);
}
function tbl(headHtml, bodyHtml){ return '<div class="tbl-wrap" style="margin-top:8px"><table><thead>'+headHtml+'</thead><tbody>'+bodyHtml+'</tbody></table></div>'; }
function renderFaReview(d){
  var out='';
  if(d.disposals && d.disposals.length){
    out+='<div style="margin-top:14px"><b style="color:#6f4410">Disposals / credits to fixed-asset ledgers ('+d.disposals.length+')</b> — match each to an asset row, then set its disposal date &amp; sale proceeds.'+
      tbl('<tr><th class="l">Date</th><th class="l">Ledger</th><th class="l">Narration</th><th>Amount</th></tr>',
        d.disposals.map(function(x){return '<tr><td class="l">'+fmt(x.date)+'</td><td class="l">'+esc(x.ledger)+'</td><td class="l">'+esc(x.narration||'')+'</td><td class="num">'+money(x.amount)+'</td></tr>';}).join(''))+'</div>';
  }
  if(d.faLedgers && d.faLedgers.length){
    out+='<div style="margin-top:14px"><b>Fixed-asset ledgers in Tally</b> — opening &amp; closing per ledger, to reconcile against your register\'s gross block.'+
      tbl('<tr><th class="l">Ledger</th><th class="l">Group</th><th>Opening (Dr+)</th><th>Closing</th></tr>',
        d.faLedgers.map(function(l){return '<tr><td class="l">'+esc(l.name)+'</td><td class="l muted">'+esc(l.group)+'</td><td class="num">'+money(l.opening)+'</td><td class="num">'+money(l.closing)+'</td></tr>';}).join(''))+'</div>';
  }
  $('#faReview').innerHTML=out;
}
$('#pull').addEventListener('click',pullFromTally);
$('#conn-upd').addEventListener('click',updateConnector);

/* ---------------- boot ---------------- */
syncFyStart(); refTable(); load(); render(); checkConn();
})();
