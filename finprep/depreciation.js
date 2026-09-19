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
  if(a && a.excl){ return {openGross:0,openAccum:0,openNet:0,additions:0,deletionsGross:0,depForYear:0,depOnDeletion:0,closeGross:0,closeAccum:0,closeWDV:0,disposed:false,wdvAtDisposal:null,profitLoss:null,daysHeld:0,yearDays:1,residual:0,bookValue:0}; }
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
var itOpen={}; // Income-tax block -> opening WDV (as per last IT return)
var dt={rate:'25.168', open:'', others:[]}; // deferred tax inputs
function fy(){ return {start:$('#fyStart').value, end:$('#fyEnd').value}; }
function classLife(label){ var c=CLASSES.find(function(x){return x.label===label;}); return c?c.life:0; }
function blankRow(){ return {desc:'',cls:'Computers — end-user (laptop/desktop)',life:3,method:$('#defMethod').value,resPct:$('#defRes').value,dateInUse:'',cost:'',openAccum:'',disposalDate:'',proceeds:''}; }
function money(n){ if(n==null||n==='')return ''; return (+n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }

/* ---------------- FY sync ---------------- */
function syncFyStart(){ var e=$('#fyEnd').value; if(!e){return;} var d=new Date(e); var s=new Date(Date.UTC(d.getUTCFullYear()-1,d.getUTCMonth(),d.getUTCDate()+1)); $('#fyStart').value=s.toISOString().slice(0,10); }
$('#fyEnd').addEventListener('change',function(){ syncFyStart(); load(); render(); });

/* ---------------- render ---------------- */
/* ---------------- Income-tax depreciation (Section 32, block of assets) ---------------- */
var IT_BLOCKS=[
  {name:'Building', rate:10}, {name:'Building — temporary structures', rate:40},
  {name:'Furniture & Fittings', rate:10}, {name:'Plant & Machinery', rate:15},
  {name:'Motor Vehicles', rate:15}, {name:'Motor Vehicles — commercial (hire)', rate:30},
  {name:'Computers & software', rate:40}, {name:'Intangible assets', rate:25}
];
function itBlockOf(rate){ return IT_BLOCKS.find(function(b){return b.rate===rate;}); }
function classToBlock(cls){
  var map={
    'Building — RCC frame':'Building','Building — other than RCC':'Building','Building — temporary structures':'Building — temporary structures',
    'Plant & Machinery — general':'Plant & Machinery','Plant & Machinery — continuous process':'Plant & Machinery',
    'Furniture & Fittings — general':'Furniture & Fittings','Furniture & Fittings — hotels/restaurants':'Furniture & Fittings',
    'Office Equipment':'Plant & Machinery','Computers — end-user (laptop/desktop)':'Computers & software','Computers — servers & networks':'Computers & software',
    'Electrical Installations & Equipment':'Plant & Machinery','Motor Vehicle — car (non-commercial)':'Motor Vehicles',
    'Motor Vehicle — commercial (bus/lorry/taxi)':'Motor Vehicles — commercial (hire)','Motor Cycle / Scooter':'Motor Vehicles',
    'Laboratory Equipment — general':'Plant & Machinery','Intangible / Software (AS 26)':'Intangible assets','Custom':'Plant & Machinery'
  };
  var nm=map[cls]||'Plant & Machinery'; return IT_BLOCKS.find(function(b){return b.name===nm;});
}
function daysBetween(a,b){ return Math.round((Date.parse(b)-Date.parse(a))/86400000); }
function itBlockDep(openWDV,add180,addLess,sale,rate){
  var r=rate/100, poolFull=openWDV+add180, saleOnFull=Math.min(sale,poolFull), fullBase=poolFull-saleOnFull;
  var remSale=sale-saleOnFull, halfBase=Math.max(0,addLess-remSale), totalBlock=openWDV+add180+addLess-sale;
  var dep=r*Math.max(0,fullBase)+(r/2)*halfBase; if(totalBlock<=0) dep=0; var closing=Math.max(0,totalBlock-dep);
  return {dep:r2(dep),closing:r2(closing),block:r2(totalBlock)};
}
function itAdditions(){
  var F=fy(), out={};
  IT_BLOCKS.forEach(function(b){ out[b.name]={add180:0,addLess:0,sale:0,rate:b.rate}; });
  rows.forEach(function(a){ if(a.excl) return; var b=classToBlock(a.cls); if(!b) return; var o=out[b.name];
    var D=a.dateInUse||F.start;
    if(Date.parse(D)>=Date.parse(F.start) && Date.parse(D)<=Date.parse(F.end)){
      var held=daysBetween(D,F.end)+1; if(held<180) o.addLess+=(+a.cost||0); else o.add180+=(+a.cost||0);
    }
    if(a.disposalDate && Date.parse(a.disposalDate)>=Date.parse(F.start) && Date.parse(a.disposalDate)<=Date.parse(F.end)) o.sale+=(+a.proceeds||0);
  });
  return out;
}
function itSchedule(){
  var add=itAdditions(); var blocks=[]; var tot={open:0,add:0,sale:0,dep:0,close:0};
  IT_BLOCKS.forEach(function(b){ var o=add[b.name]; var open=+(itOpen[b.name]||0);
    if(!open && !o.add180 && !o.addLess && !o.sale) return; // skip empty blocks
    var c=itBlockDep(open,o.add180,o.addLess,o.sale,b.rate);
    blocks.push({name:b.name,rate:b.rate,open:open,add180:o.add180,addLess:o.addLess,sale:o.sale,dep:c.dep,close:c.closing});
    tot.open+=open; tot.add+=o.add180+o.addLess; tot.sale+=o.sale; tot.dep+=c.dep; tot.close+=c.closing;
  });
  return {blocks:blocks, tot:{open:r2(tot.open),add:r2(tot.add),sale:r2(tot.sale),dep:r2(tot.dep),close:r2(tot.close)}};
}
function bookWDVClosing(){ var F=fy(); return r2(rows.reduce(function(s,a){return s+computeAsset(a,F).closeWDV;},0)); }
function renderIT(){
  var sch=itSchedule();
  var body=sch.blocks.map(function(b){
    return '<tr><td class="l">'+b.name+'</td><td>'+b.rate+'%</td>'+
      '<td><input type="number" data-itopen="'+esc(b.name)+'" value="'+esc(itOpen[b.name]==null?'':itOpen[b.name])+'" style="width:110px;text-align:right"></td>'+
      '<td class="calc num">'+money(b.add180)+'</td><td class="calc num">'+money(b.addLess)+'</td>'+
      '<td class="calc num">'+money(b.sale)+'</td><td class="calc num">'+money(b.dep)+'</td><td class="calc num">'+money(b.close)+'</td></tr>';
  }).join('');
  // blocks with only opening (no register asset) still editable — show all standard blocks as a picker note
  var head='<table><thead><tr><th class="l">Block of assets</th><th>Rate</th><th>Opening WDV</th><th class="calc">Additions ≥180d</th><th class="calc">Additions &lt;180d</th><th class="calc">Sale proceeds</th><th class="calc">Depreciation</th><th class="calc">Closing WDV</th></tr></thead><tbody>'+
    (body||'<tr><td class="l muted" colspan="8">Enter opening WDV for a block, or add assets above.</td></tr>')+
    '<tr><td class="l" colspan="2"><b>Total</b></td><td class="num"><b>'+money(sch.tot.open)+'</b></td><td class="calc num">'+money(sch.tot.add)+'</td><td class="calc"></td><td class="calc num">'+money(sch.tot.sale)+'</td><td class="calc num"><b>'+money(sch.tot.dep)+'</b></td><td class="calc num"><b>'+money(sch.tot.close)+'</b></td></tr></tbody></table>'+
    '<div class="muted" style="margin-top:6px">Blocks not linked to a register asset: set their opening WDV here — add a row below.</div>'+
    '<div style="margin-top:6px"><select id="itBlockPick" style="padding:6px">'+IT_BLOCKS.filter(function(b){return itOpen[b.name]==null && !sch.blocks.find(function(x){return x.name===b.name;});}).map(function(b){return '<option value="'+esc(b.name)+'">'+b.name+' ('+b.rate+'%)</option>';}).join('')+'</select> <button class="btn ghost sm" id="itBlockAdd" type="button">+ Add this block</button></div>';
  $('#itNote').innerHTML=head;
  $('#itKpi').innerHTML=
    '<div class="k"><div class="v num">'+money(sch.tot.dep)+'</div><div class="t">Depreciation as per Income-tax</div></div>'+
    '<div class="k"><div class="v num">'+money(sch.tot.close)+'</div><div class="t">WDV as per IT (closing)</div></div>'+
    '<div class="k"><div class="v num">'+money(bookWDVClosing())+'</div><div class="t">WDV as per books (closing)</div></div>';
  var ib=$('#itBlockAdd'); if(ib) ib.onclick=function(){ var v=$('#itBlockPick').value; if(v){ itOpen[v]=0; render(); } };
  $('#itNote').querySelectorAll('input[data-itopen]').forEach(function(inp){
    inp.addEventListener('input',function(){ itOpen[this.getAttribute('data-itopen')]=this.value; scheduleSave(); updITKpi(); renderDT(); });
    inp.addEventListener('change',function(){ renderIT(); });
  });
}
function updITKpi(){ var sch=itSchedule(); $('#itKpi').innerHTML=
  '<div class="k"><div class="v num">'+money(sch.tot.dep)+'</div><div class="t">Depreciation as per Income-tax</div></div>'+
  '<div class="k"><div class="v num">'+money(sch.tot.close)+'</div><div class="t">WDV as per IT (closing)</div></div>'+
  '<div class="k"><div class="v num">'+money(bookWDVClosing())+'</div><div class="t">WDV as per books (closing)</div></div>'; }
var _saveT=null; function scheduleSave(){ clearTimeout(_saveT); _saveT=setTimeout(save,400); }

/* ---------------- Deferred tax (AS 22) ---------------- */
function renderDT(){
  var rate=(+dt.rate||0)/100; var sch=itSchedule();
  var bookWDV=bookWDVClosing(), taxWDV=sch.tot.close;
  var depDiff=r2(bookWDV-taxWDV); // book > tax → DTL
  var rowsHtml='<tr><td class="l">Depreciation — WDV (book) vs WDV (tax)</td><td class="calc num">'+money(bookWDV)+'</td><td class="calc num">'+money(taxWDV)+'</td>'+
    '<td class="calc num'+(depDiff<0?' neg':'')+'">'+money(depDiff)+'</td><td class="l">'+(depDiff>=0?'Deferred tax liability':'Deferred tax asset')+'</td><td></td></tr>';
  var otherDT=0;
  dt.others.forEach(function(o,i){
    var amt=+o.amount||0; var signed=(o.nature==='DTA')?-amt:amt; otherDT+=signed;
    rowsHtml+='<tr><td class="l"><input data-dt="'+i+'" data-k="desc" value="'+esc(o.desc||'')+'" placeholder="Description (e.g. 43B / provision)" style="width:220px"></td>'+
      '<td colspan="2" class="l muted">timing difference</td>'+
      '<td><input data-dt="'+i+'" data-k="amount" type="number" value="'+esc(o.amount==null?'':o.amount)+'" style="width:120px;text-align:right"></td>'+
      '<td><select data-dt="'+i+'" data-k="nature"><option value="DTL"'+(o.nature!=='DTA'?' selected':'')+'>Liability (DTL)</option><option value="DTA"'+(o.nature==='DTA'?' selected':'')+'>Asset (DTA)</option></select></td>'+
      '<td><button class="del" data-dtdel="'+i+'">✕</button></td></tr>';
  });
  var netTiming=r2(depDiff+otherDT);
  var closeDT=r2(netTiming*rate);        // + = DTL, − = DTA
  var openDT=+dt.open||0;
  var charge=r2(closeDT-openDT);         // + = deferred tax expense
  $('#dtTable').innerHTML='<table><thead><tr><th class="l">Timing difference</th><th class="calc">Book</th><th class="calc">Tax</th><th>Amount</th><th>Nature</th><th></th></tr></thead><tbody>'+rowsHtml+
    '<tr><td class="l"><b>Net timing difference</b></td><td colspan="2"></td><td class="calc num'+(netTiming<0?' neg':'')+'"><b>'+money(netTiming)+'</b></td><td colspan="2"></td></tr></tbody></table>';
  $('#dtKpi').innerHTML=
    '<div class="k"><div class="v num'+(closeDT<0?' neg':'')+'">'+money(Math.abs(closeDT))+'</div><div class="t">Closing deferred tax '+(closeDT>=0?'liability':'asset')+' @ '+(dt.rate||0)+'%</div></div>'+
    '<div class="k"><div class="v num'+(charge<0?' neg':'')+'">'+money(charge)+'</div><div class="t">Deferred tax charge / (credit) for the year → P&amp;L</div></div>'+
    '<div class="k"><div class="v num">'+money(openDT)+'</div><div class="t">Opening deferred tax (entered)</div></div>';
  $('#dtTable').querySelectorAll('[data-dt]').forEach(function(el){
    el.addEventListener('input',function(){ var i=+this.getAttribute('data-dt'),k=this.getAttribute('data-k'); dt.others[i][k]=this.value; scheduleSave(); });
    el.addEventListener('change',function(){ renderDT(); });
  });
  $('#dtTable').querySelectorAll('[data-dtdel]').forEach(function(el){ el.addEventListener('click',function(){ dt.others.splice(+this.getAttribute('data-dtdel'),1); scheduleSave(); renderDT(); }); });
}

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
      '<td style="text-align:center"><input type="checkbox" data-k="excl" data-i="'+i+'"'+(a.excl?' checked':'')+' title="Returned / reversed — exclude"></td>'+
      '<td><button class="del" data-del="'+i+'" title="Remove">✕</button></td>';
    if(a.excl) tr.style.opacity='.5';
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
    '<td class="calc num'+(tot.profitLoss<0?' neg':'')+'">'+money(r2(tot.profitLoss))+'</td><td></td><td></td>';
  renderNote(F); renderIT(); renderDT(); renderFlags(F); save();
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
  i=+i; rows[i][k]=(t.type==='checkbox')?t.checked:t.value;
  if(k==='cls'){ var life=classLife(t.value); if(life>0){ rows[i].life=life; } render(); return; }
  if(k==='excl'){ render(); return; }
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
function save(){ try{ localStorage.setItem(keyOf(), JSON.stringify({company:$('#company').value,fyEnd:$('#fyEnd').value,rows:rows,itOpen:itOpen,dt:dt})); $('#saveState').textContent='saved '+new Date().toLocaleTimeString(); }catch(e){} }
function load(){ try{ var raw=localStorage.getItem(keyOf()); if(raw){ var d=JSON.parse(raw); rows=d.rows||[]; itOpen=d.itOpen||{}; dt=d.dt||{rate:'25.168',open:'',others:[]}; if(!dt.others)dt.others=[]; } else { rows=[]; itOpen={}; dt={rate:'25.168',open:'',others:[]}; } }catch(e){ rows=[]; itOpen={}; dt={rate:'25.168',open:'',others:[]}; }
  var dr=$('#dtRate'), doo=$('#dtOpen'); if(dr)dr.value=dt.rate||''; if(doo)doo.value=dt.open||''; }
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
  // Income-tax depreciation
  var sch=itSchedule();
  var it=wb.addWorksheet('Income Tax Dep');
  it.addRow(['Depreciation as per Income-tax Act (Section 32) — block of assets']).getCell(1).font={bold:true,size:12};
  it.addRow(['Block of assets','Rate %','Opening WDV','Additions ≥180d','Additions <180d','Sale proceeds','Depreciation','Closing WDV']).font={bold:true};
  sch.blocks.forEach(function(b){ it.addRow([b.name,b.rate,r2(b.open),r2(b.add180),r2(b.addLess),r2(b.sale),r2(b.dep),r2(b.close)]); });
  it.addRow(['Total','',r2(sch.tot.open),r2(sch.tot.add),'',r2(sch.tot.sale),r2(sch.tot.dep),r2(sch.tot.close)]).font={bold:true};
  it.columns.forEach(function(c){c.width=16;}); it.getColumn(1).width=34;
  // Deferred tax
  var dtws=wb.addWorksheet('Deferred Tax');
  dtws.addRow(['Deferred tax computation (AS 22)']).getCell(1).font={bold:true,size:12};
  var rate=(+dt.rate||0)/100, bookWDV=bookWDVClosing(), taxWDV=sch.tot.close, depDiff=r2(bookWDV-taxWDV);
  dtws.addRow(['Effective tax rate',(dt.rate||0)+'%']);
  dtws.addRow(['Timing difference','Book','Tax','Amount','Nature']).font={bold:true};
  dtws.addRow(['Depreciation — WDV (book vs tax)',r2(bookWDV),r2(taxWDV),depDiff,depDiff>=0?'DTL':'DTA']);
  var otherDT=0; dt.others.forEach(function(o){ var amt=+o.amount||0; var signed=(o.nature==='DTA')?-amt:amt; otherDT+=signed; dtws.addRow([o.desc||'(timing difference)','','',amt,o.nature||'DTL']); });
  var netTiming=r2(depDiff+otherDT), closeDT=r2(netTiming*rate), openDT=+dt.open||0, charge=r2(closeDT-openDT);
  dtws.addRow(['Net timing difference','','',netTiming,'']).font={bold:true};
  dtws.addRow([]);
  dtws.addRow(['Closing deferred tax '+(closeDT>=0?'liability':'asset'),'','',Math.abs(closeDT),'']).font={bold:true};
  dtws.addRow(['Opening deferred tax (entered)','','',openDT,'']);
  dtws.addRow(['Deferred tax charge / (credit) for the year → P&L','','',charge,'']).font={bold:true};
  dtws.columns.forEach(function(c){c.width=20;}); dtws.getColumn(1).width=44;
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
/* ---------------- import opening WDV from last year's financials / working paper ---------------- */
function dnorm(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function dCellText(c){ if(!c)return null; var v=c.value; if(v&&typeof v==='object'){ if(v.formula!==undefined)return (v.result!=null&&typeof v.result!=='number')?String(v.result).trim():null; if(v.result!=null)v=v.result; else if(v.text!=null)v=v.text; else if(v.richText)v=v.richText.map(function(t){return t.text;}).join(''); else return null; } if(typeof v==='number')return null; if(v==null)return null; var s=String(v).trim(); return s||null; }
function dCellNum(c){ if(!c)return null; var v=c.value; if(v&&typeof v==='object'){ if(typeof v.result==='number')return v.result; return null; } return typeof v==='number'?v:null; }
function itBlockByName(name){ var n=dnorm(name); return IT_BLOCKS.find(function(b){ var bn=dnorm(b.name); return bn===n || n.indexOf(bn)>=0 || bn.indexOf(n)>=0; }); }
function classByLabel(label){ var n=dnorm(label); var c=CLASSES.find(function(x){ return x.label!=='Custom' && (dnorm(x.label)===n || n.indexOf(dnorm(x.label))>=0); }); return c?c.label:null; }
function beforeFyStart(){ var d=new Date($('#fyStart').value); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); }
function importLastYear(file){
  if(!window.ExcelJS){ alert('Excel library still loading — try again.'); return; }
  file.arrayBuffer().then(function(buf){ var wb=new ExcelJS.Workbook(); return wb.xlsx.load(buf).then(function(){
    var itN=0, seeds=[];
    var itws=wb.getWorksheet('Income Tax Dep');
    if(itws){ itws.eachRow(function(row){ var name=dCellText(row.getCell(1)); var closing=dCellNum(row.getCell(8)); if(name&&closing!=null){ var b=itBlockByName(name); if(b){ itOpen[b.name]=r2(closing); itN++; } } }); }
    var ppe=wb.getWorksheet('PPE Note');
    if(ppe){ ppe.eachRow(function(row){ var cls=dCellText(row.getCell(1)); var netClose=dCellNum(row.getCell(10)); if(cls&&netClose!=null&&!/block of assets|^total/i.test(cls)) seeds.push({cls:cls,net:netClose}); }); }
    if(!itws || !ppe){ wb.worksheets.forEach(function(ws){ if(ws.name==='Income Tax Dep'||ws.name==='PPE Note')return; ws.eachRow(function(row){
      var label=dCellText(row.getCell(1))||dCellText(row.getCell(2)); if(!label)return; var nums=[]; row.eachCell({includeEmpty:false},function(c){ var n=dCellNum(c); if(n!=null)nums.push(n); }); if(!nums.length)return;
      if(!itws){ var b=itBlockByName(label); if(b){ var w=nums[nums.length-1]; if(w>0){ itOpen[b.name]=r2(w); itN++; } return; } }
      if(!ppe){ var cl=classByLabel(label); if(cl){ var net=nums.length>=2?nums[nums.length-2]:nums[nums.length-1]; if(net>0) seeds.push({cls:cl,net:net}); } }
    }); }); }
    var have={}; rows.forEach(function(a){ if(/^Opening — /.test(a.desc||'')) have[a.cls]=1; });
    var schN=0; seeds.forEach(function(s){ var cls=CLASSES.find(function(c){return c.label===s.cls;})?s.cls:(classByLabel(s.cls)||'Custom'); if(!s.net||have[cls])return; have[cls]=1; rows.push({desc:'Opening — '+cls, cls:cls, life:(classLife(cls)||15), method:'WDV', resPct:5, dateInUse:beforeFyStart(), cost:r2(s.net), openAccum:0, disposalDate:'', proceeds:''}); schN++; });
    render();
    alert('Imported opening WDV — Income-tax: '+itN+' block(s); Schedule II: '+schN+' opening block row(s) seeded.\nReview the method & useful life for the opening rows.');
  }); }).catch(function(e){ alert('Could not read the file: '+e.message); });
}
$('#impLastBtn').addEventListener('click',function(){ $('#impLastFile').click(); });
$('#impLastFile').addEventListener('change',function(){ var f=this.files[0]; this.value=''; if(f) importLastYear(f); });
$('#dtRate').addEventListener('input',function(){ dt.rate=this.value; scheduleSave(); renderDT(); });
$('#dtOpen').addEventListener('input',function(){ dt.open=this.value; scheduleSave(); renderDT(); });
$('#dtAdd').addEventListener('click',function(){ dt.others.push({desc:'',amount:'',nature:'DTL'}); scheduleSave(); renderDT(); });
syncFyStart(); refTable(); load(); render(); checkConn();
})();
