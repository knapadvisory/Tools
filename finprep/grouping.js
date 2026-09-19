/* Grouping-from-last-year engine — learns ledger → Schedule III head (and
   sub-group) from a prior-year grouped trial balance, saves it to localStorage
   ('knap-grp:<norm company>'), and finprep applies it to matching ledgers. */
(function(){
'use strict';
var $=function(s){return document.querySelector(s);};
function norm(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function esc(v){ return String(v==null?'':v).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

/* Schedule III catalogue — mirrors finprep NOTES */
var NOTES={1:'Share capital',2:'Reserves and surplus',4:'Long-term borrowings',5:'Deferred tax liabilities (Net)',6:'Other long term liabilities',7:'Long-term provisions',8:'Short-term borrowings',9:'Trade payables',10:'Other current liabilities',11:'Short-term provisions',12:'Property, Plant and Equipment',13:'Non-current investments',14:'Deferred tax assets (Net)',15:'Long-term loans and advances',16:'Other non-current assets',17:'Current investments',18:'Inventories',19:'Trade receivables',20:'Cash and cash equivalents',21:'Short-term loans and advances',22:'Other current assets',23:'Revenue from operations',24:'Other income',25:'Cost of materials consumed',26:'Changes in inventories',27:'Employee benefits expense',28:'Finance costs',29:'Other expenses',99:'Unclassified — review'};
var NOTE_ORDER=[1,2,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,99];
/* synonyms: normalised head/group text → note number */
var SYN=[
  [/revenue from operation|\bsales\b|turnover|service (income|revenue)|professional (fee|charge)|contract receipt/,23],
  [/interest income|dividend income|rent received|indirect income|other income|misc.*income/,24],
  [/cost of material|material consumed|\bpurchase(s| account| a\/c)?\b/,25],
  [/changes? in inventor|change in stock/,26],
  [/employee benefit|salar|\bwages\b|staff (welfare|cost)|\bbonus\b|\bpf\b|\besic?\b|gratuity/,27],
  [/finance cost|interest (expense|on|paid|to)|bank charge|loan processing/,28],
  [/other expense|indirect expense|direct expense|rent(?! received)|repair|travel|legal|professional charge|office expense|misc.*expense|\badmin/,29],
  [/share capital|equity (share )?capital|paid ?up capital/,1],
  [/reserve|surplus|retained earning|p ?l account|profit (and|&)? ?loss account/,2],
  [/deferred tax liab/,5],[/deferred tax asset/,14],
  [/long ?term borrow|secured loan|\bterm loan\b|unsecured loan|debenture/,4],
  [/short ?term borrow|bank ?od\b|cash credit|working capital loan|overdraft/,8],
  [/trade payab|sundry creditor|creditor|payable for/,9],
  [/duties.*tax|statutory due|gst payable|tds payable|advance from custom|expenses payable|outstanding (expense|liab)|other current liab/,10],
  [/long ?term provision/,7],[/short ?term provision|provision for/,11],[/other long term liab/,6],
  [/property.*plant|fixed asset|tangible asset|plant.*machinery|\bppe\b|building|furniture|vehicle|\bcomputer|office equipment/,12],
  [/non ?current investment|long term investment/,13],[/current investment/,17],
  [/inventor|closing stock|opening stock|raw material|finished good|work in progress|stock in (trade|hand)/,18],
  [/trade receivab|sundry debtor|debtor|receivable from/,19],
  [/tds receiv|tcs receiv|short ?term (loan|advance)|prepaid|balance with (revenue|government|gst|excise)|input (cgst|sgst|igst|gst|tax)|loans? (and |& )?advances?|advance to/,21],
  [/long ?term (loan|advance)|security deposit|deposit \(asset/,15],
  [/other non ?current asset/,16],[/other current asset/,22],
  [/\bcash\b|\bbank\b|petty cash|cash and cash|cash & cash/,20]
];
function headToNote(text){
  var s=String(text==null?'':text).trim(); if(!s) return null;
  var mm=s.match(/^\s*(?:note\s*)?(\d{1,2})\b/i); if(mm && NOTES[+mm[1]]) return +mm[1];
  var n=norm(s); if(!n) return null;
  for(var i=0;i<NOTE_ORDER.length;i++){ var no=NOTE_ORDER[i]; if(norm(NOTES[no])===n) return no; }
  for(i=0;i<NOTE_ORDER.length;i++){ no=NOTE_ORDER[i]; var hn=norm(NOTES[no]); if(n.length>=5 && (hn.indexOf(n)===0 || n.indexOf(hn)===0)) return no; }
  for(i=0;i<SYN.length;i++){ if(SYN[i][0].test(n)) return SYN[i][1]; }
  return null;
}

/* ---------------- upload ---------------- */
var sheetsData={}; // sheetName -> {headers:[], rows:[[...]]}
(function(){ var d=$('#drop'), f=$('#file');
  d.addEventListener('click',function(){f.click();});
  f.addEventListener('change',function(){ if(f.files.length) readWorkbook(f.files[0]); f.value=''; });
  ['dragenter','dragover'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.add('hot');});});
  ['dragleave','drop'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.remove('hot');});});
  d.addEventListener('drop',function(ev){ var fs=ev.dataTransfer.files; if(fs.length) readWorkbook(fs[0]); });
})();
function readWorkbook(file){
  if(!window.ExcelJS){ alert('Excel library still loading — try again.'); return; }
  file.arrayBuffer().then(function(buf){ var wb=new ExcelJS.Workbook(); return wb.xlsx.load(buf).then(function(){
    sheetsData={}; wb.worksheets.forEach(function(ws){
      var rows=[]; ws.eachRow(function(row){ var arr=[]; row.eachCell({includeEmpty:true},function(cell){ var v=cell.value; if(v&&v.result!=null)v=v.result; if(v&&v.text!=null)v=v.text; arr.push(v==null?'':v); }); rows.push(arr); });
      if(rows.length){ sheetsData[ws.name]={ rows:rows }; }
    });
    var names=Object.keys(sheetsData); if(!names.length){ alert('No data found in the workbook.'); return; }
    var sel=$('#sheet'); sel.innerHTML=names.map(function(n){return '<option>'+esc(n)+'</option>';}).join('');
    $('#mapWrap').classList.remove('hide'); onSheet();
  }); }).catch(function(e){ alert('Could not read the file: '+e.message); });
}
$('#sheet').addEventListener('change',onSheet);
function onSheet(){
  var name=$('#sheet').value, sd=sheetsData[name]; if(!sd) return;
  // header = first row that has >=2 non-empty text cells
  var hdrIdx=0; for(var i=0;i<Math.min(sd.rows.length,8);i++){ var nonEmpty=sd.rows[i].filter(function(c){return String(c).trim()!=='';}).length; if(nonEmpty>=2){ hdrIdx=i; break; } }
  sd.hdrIdx=hdrIdx; var headers=sd.rows[hdrIdx].map(function(c,idx){ var t=String(c).trim(); return t||('Column '+(idx+1)); });
  sd.headers=headers;
  function opts(guess){ return headers.map(function(h,idx){ return '<option value="'+idx+'"'+(idx===guess?' selected':'')+'>'+esc(h)+'</option>'; }).join(''); }
  var gLed=guessCol(headers,[/ledger|particular|account|name|head of account/]);
  var gHead=guessCol(headers,[/group|head|schedule|classif|note|category/]);
  var gSub=guessCol(headers,[/sub ?group|sub ?head|sub ?class/]);
  $('#colLedger').innerHTML=opts(gLed>=0?gLed:0);
  $('#colHead').innerHTML=opts(gHead>=0?gHead:1);
  $('#colSub').innerHTML='<option value="-1">— none —</option>'+opts(gSub);
  if(gSub<0) $('#colSub').value='-1';
}
function guessCol(headers,pats){ for(var i=0;i<headers.length;i++){ var h=norm(headers[i]); for(var j=0;j<pats.length;j++){ if(pats[j].test(h)) return i; } } return -1; }

/* ---------------- learn ---------------- */
var learned=[]; // {ledger, head, note, sub}
$('#learn').addEventListener('click',function(){
  var name=$('#sheet').value, sd=sheetsData[name]; if(!sd) return;
  var cl=+$('#colLedger').value, ch=+$('#colHead').value, cs=+$('#colSub').value;
  learned=[]; var seen={};
  for(var i=(sd.hdrIdx||0)+1;i<sd.rows.length;i++){ var r=sd.rows[i];
    var led=String(r[cl]==null?'':r[cl]).trim(); var head=String(r[ch]==null?'':r[ch]).trim(); var sub=(cs>=0)?String(r[cs]==null?'':r[cs]).trim():'';
    if(!led) continue; if(/^(total|grand total|sub ?total)/i.test(led)) continue;
    var key=norm(led); if(!key||seen[key]) continue; seen[key]=1;
    learned.push({ledger:led, head:head, note:headToNote(head||sub), sub:sub});
  }
  renderLearned();
});
function noteSelect(val,i){ return '<select data-i="'+i+'" data-k="note"><option value="">— unmatched —</option>'+NOTE_ORDER.map(function(no){return '<option value="'+no+'"'+(String(val)===String(no)?' selected':'')+'>'+no+' · '+NOTES[no]+'</option>';}).join('')+'</select>'; }
function renderLearned(){
  $('#resultCard').classList.remove('hide');
  var tb=$('#rows'); tb.innerHTML='';
  var matched=0;
  learned.forEach(function(x,i){ if(x.note!=null) matched++;
    var tr=document.createElement('tr');
    tr.innerHTML='<td>'+esc(x.ledger)+'</td><td class="muted">'+esc(x.head||'')+'</td><td>'+noteSelect(x.note,i)+'</td><td><input data-i="'+i+'" data-k="sub" value="'+esc(x.sub||'')+'"></td>';
    tb.appendChild(tr);
  });
  $('#kpi').innerHTML=
    '<div class="k"><div class="v">'+learned.length+'</div><div class="t">ledgers learned</div></div>'+
    '<div class="k"><div class="v">'+matched+'</div><div class="t">auto-matched to a head</div></div>'+
    '<div class="k"><div class="v">'+(learned.length-matched)+'</div><div class="t">need your pick</div></div>';
}
$('#rows').addEventListener('input',function(e){ var t=e.target; var i=t.getAttribute('data-i'), k=t.getAttribute('data-k'); if(i==null)return; i=+i; if(k==='note') learned[i].note=t.value===''?null:+t.value; else learned[i][k]=t.value; });

/* ---------------- save / load ---------------- */
function keyOf(){ return 'knap-grp:'+norm($('#company').value); }
$('#save').addEventListener('click',function(){
  if(!$('#company').value.trim()){ alert('Enter the company name first — the map is saved per company.'); return; }
  if(!learned.length){ alert('Nothing learned yet.'); return; }
  var map={}, list=[];
  learned.forEach(function(x){ if(x.note==null) return; map[norm(x.ledger)]={note:+x.note, head:NOTES[+x.note], sub:x.sub||''}; list.push({ledger:x.ledger,note:+x.note,sub:x.sub||''}); });
  try{ localStorage.setItem(keyOf(), JSON.stringify({company:$('#company').value, savedAt:new Date().toISOString(), map:map, list:list}));
    $('#savedMsg').textContent='Saved '+list.length+' groupings — they will apply when you build financials for “'+$('#company').value+'”.'; $('#savedMsg').style.color='#14461f';
  }catch(e){ $('#savedMsg').textContent='Could not save: '+e.message; $('#savedMsg').style.color='#b42318'; }
});
$('#loadSaved').addEventListener('click',function(){
  var raw; try{ raw=localStorage.getItem(keyOf()); }catch(e){}
  if(!raw){ $('#saveState').textContent='No saved map for this company yet.'; return; }
  try{ var d=JSON.parse(raw); learned=(d.list||[]).map(function(x){return {ledger:x.ledger,head:NOTES[x.note]||'',note:x.note,sub:x.sub||''};}); renderLearned(); $('#saveState').textContent='Loaded '+learned.length+' saved groupings ('+(d.savedAt?new Date(d.savedAt).toLocaleDateString():'')+').'; }catch(e){ $('#saveState').textContent='Saved map is unreadable.'; }
});
})();
