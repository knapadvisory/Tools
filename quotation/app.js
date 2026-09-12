/* KNAP Quotation Maker — client logic. Talks to /quotation/api/* (server store). */
var $=function(s){return document.querySelector(s);};
var API='/quotation/api';
var companies=[], editingId=null, logoCache={};

function api(path, opts){ return fetch(API+path, opts).then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); }); }
function money(n,cur){ cur=cur||'₹'; var v=Math.round((+n||0)*100)/100; var loc=cur==='₹'?'en-IN':'en-US'; return cur+' '+v.toLocaleString(loc,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function lines(id){ return ($('#'+id).value||'').split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean); }

/* ---------- calculation (shared by UI + generator) ---------- */
function calcOf(d){
  var sub=(d.services||[]).reduce(function(t,s){return t+(+s.qty||0)*(+s.rate||0);},0);
  var dm=d.discount&&d.discount.mode, dv=+(d.discount&&d.discount.value)||0;
  var disc = dm==='pct'? sub*dv/100 : (dm==='amt'? dv : 0); disc=Math.max(0,Math.min(disc,sub));
  var taxable=sub-disc;
  var gstOn=!!(d.gst&&d.gst.enabled), rate=gstOn?(+d.gst.rate||0):0, inter=!!(d.gst&&d.gst.mode==='inter');
  var tax=gstOn?taxable*rate/100:0, cgst=0,sgst=0,igst=0;
  if(gstOn){ if(inter) igst=tax; else { cgst=tax/2; sgst=tax/2; } }
  var grand=taxable+tax, rounded=d.round?Math.round(grand):Math.round(grand*100)/100, roundOff=rounded-grand;
  return {sub:sub,disc:disc,taxable:taxable,gstOn:gstOn,rate:rate,inter:inter,tax:tax,cgst:cgst,sgst:sgst,igst:igst,grand:grand,rounded:rounded,roundOff:roundOff};
}

/* ---------- Word generator ---------- */
function buildQuoteDoc(docx, data, logo, logoType){
  var D=docx, {Document,Paragraph,TextRun,ImageRun,Table,TableRow,TableCell,WidthType,AlignmentType,ShadingType,BorderStyle,VerticalAlign}=D;
  var INK='292928', BRAND=(data.company&&data.company.brand||'0070C0').replace('#',''), DARK='0B2A4A', FONT='Tahoma', cur=data.currency||'₹';
  var c=calcOf(data), services=(data.services||[]).filter(function(s){return (s.desc||'').trim();});
  var run=function(t,o){o=o||{};return new TextRun(Object.assign({text:String(t==null?'':t),font:FONT},o));};
  var P=function(ch,o){o=o||{};return new Paragraph(Object.assign({children:Array.isArray(ch)?ch:[ch]},o));};
  var bullet=function(t){return new Paragraph({children:[run(t,{size:19,color:INK})],bullet:{level:0},spacing:{after:20}});};
  var heading=function(t){return P([run(t,{bold:true,size:22,color:BRAND})],{spacing:{before:200,after:80},border:{bottom:{style:BorderStyle.SINGLE,size:6,color:BRAND,space:2}}});};
  var noB=function(){var n={style:BorderStyle.NONE};return{top:n,bottom:n,left:n,right:n};};
  var cols=[560,4906,900,1330,1330];
  var cell=function(ch,w,o){o=o||{};return new TableCell({width:{size:w,type:WidthType.DXA},verticalAlign:VerticalAlign.CENTER,shading:o.fill?{type:ShadingType.CLEAR,color:'auto',fill:o.fill}:undefined,margins:{top:40,bottom:40,left:90,right:90},children:Array.isArray(ch)?ch:[ch]});};
  var hCell=function(t,w,al){return cell(P([run(t,{bold:true,size:18,color:'FFFFFF'})],{alignment:al||AlignmentType.LEFT}),w,{fill:BRAND});};
  var tCell=function(t,w,al){return cell(P([run(t,{size:18,color:INK})],{alignment:al||AlignmentType.LEFT}),w);};
  var headerRow=new TableRow({tableHeader:true,children:[hCell('#',cols[0],AlignmentType.CENTER),hCell('Particulars',cols[1]),hCell('Qty',cols[2],AlignmentType.CENTER),hCell('Rate',cols[3],AlignmentType.RIGHT),hCell('Amount',cols[4],AlignmentType.RIGHT)]});
  var bodyRows=services.map(function(s,i){return new TableRow({children:[tCell(String(i+1),cols[0],AlignmentType.CENTER),tCell(s.desc,cols[1]),tCell(String(s.qty||''),cols[2],AlignmentType.CENTER),tCell(money(s.rate,cur),cols[3],AlignmentType.RIGHT),tCell(money((+s.qty||0)*(+s.rate||0),cur),cols[4],AlignmentType.RIGHT)]});});
  var servicesTable=new Table({columnWidths:cols,width:{size:cols.reduce(function(a,b){return a+b;},0),type:WidthType.DXA},rows:[headerRow].concat(bodyRows)});

  // totals block (right-aligned)
  var tW=[2500,1600];
  var trow=function(label,val,o){o=o||{};return new TableRow({children:[
    new TableCell({width:{size:tW[0],type:WidthType.DXA},borders:noB(),margins:{top:20,bottom:20,left:90,right:90},children:[P([run(label,{size:o.b?20:18,color:o.b?BRAND:INK,bold:!!o.b})],{alignment:AlignmentType.RIGHT})]}),
    new TableCell({width:{size:tW[1],type:WidthType.DXA},borders:o.top?{top:{style:BorderStyle.SINGLE,size:4,color:'CCCCCC'},bottom:noB().bottom,left:noB().left,right:noB().right}:noB(),margins:{top:20,bottom:20,left:90,right:90},children:[P([run(val,{size:o.b?20:18,color:o.b?BRAND:INK,bold:!!o.b})],{alignment:AlignmentType.RIGHT})]})]});};
  var tRows=[trow('Subtotal',money(c.sub,cur))];
  if(c.disc>0.005) tRows.push(trow('Discount','− '+money(c.disc,cur)));
  if(c.disc>0.005||c.gstOn) tRows.push(trow('Taxable value',money(c.taxable,cur)));
  if(c.gstOn&&c.inter) tRows.push(trow('IGST @ '+c.rate+'%',money(c.igst,cur)));
  if(c.gstOn&&!c.inter){ tRows.push(trow('CGST @ '+(c.rate/2)+'%',money(c.cgst,cur))); tRows.push(trow('SGST @ '+(c.rate/2)+'%',money(c.sgst,cur))); }
  if(Math.abs(c.roundOff)>0.004) tRows.push(trow('Round off',(c.roundOff>0?'+ ':'− ')+money(Math.abs(c.roundOff),cur)));
  tRows.push(trow('Grand Total',money(c.rounded,cur),{b:true,top:true}));
  var totalsTable=new Table({alignment:AlignmentType.RIGHT,columnWidths:tW,width:{size:tW[0]+tW[1],type:WidthType.DXA},borders:{top:noB().top,bottom:noB().bottom,left:noB().left,right:noB().right,insideHorizontal:noB().top,insideVertical:noB().left},rows:tRows});

  var bank=data.bank||{};
  var bankLine=function(l,v){return v?P([run(l+'  ',{bold:true,size:18,color:INK}),run(v,{size:18,color:INK})],{spacing:{after:10}}):null;};
  var banner=new Table({columnWidths:[9026],width:{size:9026,type:WidthType.DXA},rows:[new TableRow({children:[new TableCell({width:{size:9026,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,color:'auto',fill:DARK},margins:{top:80,bottom:80,left:160,right:160},children:[P([run('PAYMENT  DETAILS',{bold:true,size:24,color:'FFFFFF'})])]})]})]});

  var kids=[];
  if(logo) kids.push(P([new ImageRun({type:logoType||'png',data:logo,transformation:{width:232,height:92}})],{spacing:{after:60}}));
  kids.push(new Table({columnWidths:[5400,3626],width:{size:9026,type:WidthType.DXA},borders:{top:{style:BorderStyle.NONE},bottom:{style:BorderStyle.NONE},left:{style:BorderStyle.NONE},right:{style:BorderStyle.NONE},insideHorizontal:{style:BorderStyle.NONE},insideVertical:{style:BorderStyle.NONE}},rows:[new TableRow({children:[
    new TableCell({width:{size:5400,type:WidthType.DXA},borders:noB(),children:[P([run('Quotation No: ',{bold:true,size:19,color:INK}),run(data.quoteNo||'',{size:19,color:INK})]),P([run('Applicant: ',{bold:true,size:19,color:INK}),run(data.name||'',{size:19,color:INK})]),P([run('City: ',{bold:true,size:19,color:INK}),run(data.city||'',{size:19,color:INK})])]}),
    new TableCell({width:{size:3626,type:WidthType.DXA},borders:noB(),children:[P([run('Date: ',{bold:true,size:19,color:INK}),run(data.date||'',{size:19,color:INK})],{alignment:AlignmentType.RIGHT})]})]})]}));
  kids.push(P([run(data.subject||'Quotation',{bold:true,size:26,color:DARK})],{alignment:AlignmentType.CENTER,spacing:{before:200,after:160}}));
  kids.push(servicesTable);
  kids.push(P([run('')],{spacing:{before:60}}));
  kids.push(totalsTable);
  if((data.terms||[]).length){kids.push(heading('Terms'));data.terms.forEach(function(t){kids.push(bullet(t));});}
  if((data.deliverables||[]).length){kids.push(heading('Deliverables'));data.deliverables.forEach(function(t){kids.push(bullet(t));});}
  if((data.checklist||[]).length){kids.push(heading('Documents / Checklist'));data.checklist.forEach(function(t){kids.push(bullet(t));});}
  kids.push(P([run('')],{spacing:{before:160}}));
  kids.push(banner);
  [bankLine('Account No.',bank.ac),bankLine('Entity Name',bank.entity),bankLine('IFSC Code',bank.ifsc),bankLine('Google Pay / Paytm / PhonePe',bank.upi),bankLine('Payment terms',bank.terms),bankLine('Contact person',bank.contact),bankLine('Phone',bank.phone),bankLine('Email',bank.email)].filter(Boolean).forEach(function(p){kids.push(p);});
  return new Document({styles:{default:{document:{run:{font:FONT,size:19,color:INK}}}},sections:[{properties:{page:{margin:{top:900,bottom:900,left:1000,right:1000}}},children:kids}]});
}

/* ---------- PDF generator (pdfmake) ---------- */
// PDF uses "Rs." for INR (pdfmake's bundled Roboto renders that reliably); the
// Word doc keeps the ₹ glyph. Other currencies use their symbol.
function pmoney(n,cur){ cur=cur||'₹'; var v=Math.round((+n||0)*100)/100; var loc=cur==='₹'?'en-IN':'en-US'; var sym=cur==='₹'?'Rs. ':(cur+' '); return sym+v.toLocaleString(loc,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function buildQuotePdf(data, logoDataUrl){
  var c=calcOf(data), cur=data.currency||'₹', brand='#'+String(data.company&&data.company.brand||'0070C0').replace('#',''), DARK='#0B2A4A';
  var services=(data.services||[]).filter(function(s){return (s.desc||'').trim();});
  var hdr=function(t,al){return {text:t,bold:true,color:'white',fontSize:9,fillColor:brand,alignment:al||'left',margin:[0,3,0,3]};};
  var td=function(t,al){return {text:t,fontSize:9,alignment:al||'left',margin:[0,2,0,2]};};
  var body=[[hdr('#','center'),hdr('Particulars'),hdr('Qty','center'),hdr('Rate','right'),hdr('Amount','right')]];
  services.forEach(function(s,i){ body.push([td(String(i+1),'center'),td(s.desc),td(String(s.qty||''),'center'),td(pmoney(s.rate,cur),'right'),td(pmoney((+s.qty||0)*(+s.rate||0),cur),'right')]); });
  var trows=[]; var tr=function(l,v,o){o=o||{};trows.push([{text:l,alignment:'right',bold:!!o.b,fontSize:o.b?11:9,color:o.b?brand:'#292928'},{text:v,alignment:'right',bold:!!o.b,fontSize:o.b?11:9,color:o.b?brand:'#292928'}]);};
  tr('Subtotal',pmoney(c.sub,cur));
  if(c.disc>0.005) tr('Discount','- '+pmoney(c.disc,cur));
  if(c.disc>0.005||c.gstOn) tr('Taxable value',pmoney(c.taxable,cur));
  if(c.gstOn&&c.inter) tr('IGST @ '+c.rate+'%',pmoney(c.igst,cur));
  if(c.gstOn&&!c.inter){ tr('CGST @ '+(c.rate/2)+'%',pmoney(c.cgst,cur)); tr('SGST @ '+(c.rate/2)+'%',pmoney(c.sgst,cur)); }
  if(Math.abs(c.roundOff)>0.004) tr('Round off',(c.roundOff>0?'+ ':'- ')+pmoney(Math.abs(c.roundOff),cur));
  tr('Grand Total',pmoney(c.rounded,cur),{b:true});
  var content=[];
  if(logoDataUrl) content.push({image:logoDataUrl,width:175,margin:[0,0,0,8]});
  content.push({columns:[
    {width:'*',fontSize:10,stack:[{text:[{text:'Quotation No: ',bold:true},data.quoteNo||'']},{text:[{text:'Applicant: ',bold:true},data.name||'']},{text:[{text:'City: ',bold:true},data.city||'']}]},
    {width:'auto',fontSize:10,alignment:'right',text:[{text:'Date: ',bold:true},data.date||'']}
  ]});
  content.push({text:data.subject||'Quotation',bold:true,fontSize:15,color:DARK,alignment:'center',margin:[0,12,0,10]});
  content.push({table:{headerRows:1,widths:[18,'*',34,66,72],body:body},layout:{hLineColor:function(){return '#dddddd';},vLineColor:function(){return '#dddddd';},hLineWidth:function(){return 0.5;},vLineWidth:function(){return 0.5;}}});
  content.push({columns:[{width:'*',text:''},{width:230,table:{widths:['*',95],body:trows},layout:'noBorders'}],margin:[0,8,0,0]});
  var section=function(title,arr){ if(!arr||!arr.length) return; content.push({text:title,bold:true,color:brand,fontSize:11,margin:[0,12,0,3]}); content.push({ul:arr,fontSize:9}); };
  section('Terms',data.terms); section('Deliverables',data.deliverables); section('Documents / Checklist',data.checklist);
  content.push({table:{widths:['*'],body:[[{text:'PAYMENT  DETAILS',color:'white',bold:true,fontSize:12,fillColor:DARK,margin:[8,6,8,6]}]]},layout:'noBorders',margin:[0,14,0,6]});
  var bank=data.bank||{};
  [['Account No.',bank.ac],['Entity Name',bank.entity],['IFSC Code',bank.ifsc],['Google Pay / Paytm / PhonePe',bank.upi],['Payment terms',bank.terms],['Contact person',bank.contact],['Phone',bank.phone],['Email',bank.email]]
    .filter(function(x){return x[1];}).forEach(function(x){ content.push({text:[{text:x[0]+'  ',bold:true},x[1]],fontSize:9,margin:[0,0,0,2]}); });
  return { pageSize:'A4', pageMargins:[40,40,40,44], content:content, defaultStyle:{font:'Roboto',fontSize:10,color:'#292928'} };
}
function logoDataUrlFor(id){
  var co=companies.find(function(x){return x.id===id;}); if(!co||!co.logoFile) return Promise.resolve(null);
  return fetch(API+'/companies/'+id+'/logo',{cache:'no-store'}).then(function(r){return r.blob();}).then(function(b){ return new Promise(function(res){ var fr=new FileReader(); fr.onload=function(){res(fr.result);}; fr.onerror=function(){res(null);}; fr.readAsDataURL(b); }); }).catch(function(){return null;});
}
function downloadPdf(){
  var d=gather(); if(!d.services.length){ $('#stat').textContent='Add at least one service.'; return; }
  if(!window.pdfMake){ $('#stat').textContent='PDF engine not loaded.'; return; }
  $('#stat').textContent='Building PDF…';
  logoDataUrlFor(d.companyId).then(function(logo){
    window.pdfMake.createPdf(buildQuotePdf(d,logo)).download('Quotation '+(d.name||'client')+' '+(d.no||'')+'.pdf', function(){ $('#stat').textContent='Downloaded PDF.'; });
  }).catch(function(e){ $('#stat').textContent='PDF error: '+e.message; });
}

/* ---------- form ---------- */
function fyLabel(d){var y=d.getFullYear(),m=d.getMonth(),s=(m>=3)?y:y-1;return String(s%100)+'-'+String((s+1)%100);}
function svcRow(desc,qty,rate){
  var tr=document.createElement('tr'); tr.className='svc';
  tr.innerHTML='<td class="idx"></td><td><input class="d" placeholder="Service / particular" value="'+(desc||'').replace(/"/g,'&quot;')+'"></td><td><input class="q" type="number" min="0" step="1" value="'+(qty==null?1:qty)+'"></td><td><input class="r" type="number" min="0" step="0.01" value="'+(rate==null?'':rate)+'"></td><td class="amt">—</td><td><button class="rm" title="Remove">✕</button></td>';
  tr.querySelector('.rm').addEventListener('click',function(){tr.remove();recompute();});
  tr.addEventListener('input',recompute);
  return tr;
}
function curNow(){return $('#currency').value||'₹';}
function recompute(){
  var d=gather(); var c=calcOf(d), cur=curNow();
  document.querySelectorAll('#svcBody tr').forEach(function(tr,i){ var q=+tr.querySelector('.q').value||0,r=+tr.querySelector('.r').value||0; tr.querySelector('.idx').textContent=i+1; tr.querySelector('.amt').textContent=money(q*r,cur); });
  var t=$('#totals'), h='<div><span>Subtotal</span><b>'+money(c.sub,cur)+'</b></div>';
  if(c.disc>0.005) h+='<div><span>Discount</span><b>− '+money(c.disc,cur)+'</b></div>';
  if(c.disc>0.005||c.gstOn) h+='<div><span>Taxable value</span><b>'+money(c.taxable,cur)+'</b></div>';
  if(c.gstOn&&c.inter) h+='<div><span>IGST @ '+c.rate+'%</span><b>'+money(c.igst,cur)+'</b></div>';
  if(c.gstOn&&!c.inter) h+='<div><span>CGST @ '+(c.rate/2)+'%</span><b>'+money(c.cgst,cur)+'</b></div><div><span>SGST @ '+(c.rate/2)+'%</span><b>'+money(c.sgst,cur)+'</b></div>';
  if(Math.abs(c.roundOff)>0.004) h+='<div><span>Round off</span><b>'+(c.roundOff>0?'+ ':'− ')+money(Math.abs(c.roundOff),cur)+'</b></div>';
  h+='<div class="grand"><span>Grand Total</span><span>'+money(c.rounded,cur)+'</span></div>';
  t.innerHTML=h;
}
function gather(){
  var services=[]; document.querySelectorAll('#svcBody tr').forEach(function(tr){var d=tr.querySelector('.d').value.trim(); if(d) services.push({desc:d,qty:+tr.querySelector('.q').value||0,rate:+tr.querySelector('.r').value||0});});
  var co=companies.find(function(x){return x.id===$('#companyId').value;})||{};
  var d={ no:$('#quoteNo').value.trim(), quoteNo:$('#quoteNo').value.trim(), companyId:$('#companyId').value, date:$('#date').value.trim(),
    currency:curNow(), name:$('#name').value.trim(), city:$('#city').value.trim(), subject:$('#subject').value.trim(),
    client:{name:$('#name').value.trim(),city:$('#city').value.trim()}, services:services,
    gst:{enabled:$('#gstOn').value==='yes', rate:+$('#gstRate').value||0, mode:$('#gstMode').value}, round:$('#round').value==='yes',
    discount:{mode:$('#discMode').value, value:+$('#discVal').value||0},
    terms:lines('terms'), deliverables:lines('deliverables'), checklist:lines('checklist'),
    company:{name:co.name||'', brand:co.brand||'0070C0', tagline:co.tagline||''},
    bank:{ac:$('#b_ac').value.trim(),entity:$('#b_entity').value.trim(),ifsc:$('#b_ifsc').value.trim(),upi:$('#b_upi').value.trim(),terms:$('#b_terms').value.trim(),contact:$('#b_contact').value.trim(),phone:$('#b_phone').value.trim(),email:$('#b_email').value.trim()} };
  d.total=calcOf(d).rounded; return d;
}
function fill(d){
  $('#quoteNo').value=d.no||d.quoteNo||''; $('#date').value=d.date||''; $('#currency').value=d.currency||'₹';
  $('#name').value=(d.client&&d.client.name)||d.name||''; $('#city').value=(d.client&&d.client.city)||d.city||''; $('#subject').value=d.subject||'';
  if(d.companyId){ $('#companyId').value=d.companyId; }
  $('#gstOn').value=(d.gst&&d.gst.enabled)?'yes':'no'; $('#gstRate').value=String((d.gst&&d.gst.rate)||18); $('#gstMode').value=(d.gst&&d.gst.mode)||'intra';
  $('#round').value=(d.round===false)?'no':'yes'; $('#discMode').value=(d.discount&&d.discount.mode)||'none'; $('#discVal').value=(d.discount&&d.discount.value)||0;
  $('#terms').value=(d.terms||[]).join('\n'); $('#deliverables').value=(d.deliverables||[]).join('\n'); $('#checklist').value=(d.checklist||[]).join('\n');
  var b=d.bank||{}; ['ac','entity','ifsc','upi','terms','contact','phone','email'].forEach(function(k){$('#b_'+k).value=b[k]||'';});
  $('#svcBody').innerHTML=''; (d.services&&d.services.length?d.services:[{}]).forEach(function(s){$('#svcBody').appendChild(svcRow(s.desc,s.qty,s.rate));});
  recompute();
}
function setCompanyBank(force){ var co=companies.find(function(x){return x.id===$('#companyId').value;}); if(!co) return; var b=co.bank||{}; ['ac','entity','ifsc','upi','terms','contact','phone','email'].forEach(function(k){ if(force||!$('#b_'+k).value) $('#b_'+k).value=b[k]||''; }); document.documentElement.style.setProperty('--brand', '#'+(co.brand||'0070C0')); }
function applyCompanyBank(){ setCompanyBank(false); }

function newBlank(){
  editingId=null; $('#editBadge').classList.add('hide'); $('#revise').classList.add('hide');
  var today=new Date();
  var seq=(parseInt(localStorage.getItem('knap_quote_seq')||'0',10)+1);
  fill({ no:'QT-'+fyLabel(today)+'-'+String(seq).padStart(3,'0'), date:today.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}), currency:'₹',
    gst:{enabled:false,rate:18,mode:'intra'}, round:true, discount:{mode:'none',value:0},
    terms:['50% in advance, 50% on completion','Government / statutory fees at actuals','Timeline subject to timely submission of documents'],
    deliverables:['Certificate / registration','Supporting documents'], checklist:['PAN & Aadhaar','Address proof','Mobile number & email id'],
    services:[{qty:1},{qty:1}] });
  document.querySelectorAll('#b_ac,#b_entity,#b_ifsc,#b_upi,#b_terms,#b_contact,#b_phone,#b_email').forEach(function(el){el.value='';});
  setCompanyBank(true); $('#stat').textContent='';
}

/* ---------- logo bytes ---------- */
function logoFor(companyId){
  var co=companies.find(function(x){return x.id===companyId;});
  if(!co||!co.logoFile) return Promise.resolve({bytes:null,type:'png'});
  if(logoCache[companyId]) return Promise.resolve(logoCache[companyId]);
  var type=/\.jpe?g$/i.test(co.logoFile)?'jpg':'png';
  return fetch(API+'/companies/'+companyId+'/logo',{cache:'no-store'}).then(function(r){return r.arrayBuffer();}).then(function(b){ logoCache[companyId]={bytes:new Uint8Array(b),type:type}; return logoCache[companyId]; }).catch(function(){return {bytes:null,type:type};});
}

/* ---------- actions ---------- */
function downloadWord(){
  var d=gather(); if(!d.services.length){$('#stat').textContent='Add at least one service.';return;}
  $('#stat').textContent='Building…';
  logoFor(d.companyId).then(function(l){
    var doc=buildQuoteDoc(window.docx,d,l.bytes,l.type);
    return window.docx.Packer.toBlob(doc);
  }).then(function(blob){
    var url=URL.createObjectURL(blob),a=document.createElement('a'); a.href=url; a.download='Quotation '+(d.name||'client')+' '+(d.no||'')+'.docx';
    document.body.appendChild(a);a.click();setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},1500);
    var seq=parseInt((String(d.no).match(/(\d+)$/)||[])[1]||'0',10); if(seq) localStorage.setItem('knap_quote_seq',String(seq));
    $('#stat').textContent='Downloaded '+a.download;
  }).catch(function(e){$('#stat').textContent='Error: '+e.message;});
}
function saveQuote(){
  var d=gather(); if(!d.name){$('#stat').textContent='Enter a client name first.';return;}
  $('#stat').textContent='Saving…';
  api('/quotes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(function(j){
    editingId=j.quote.id; $('#editBadge').textContent='saved · rev 1'; $('#editBadge').classList.remove('hide'); $('#revise').classList.remove('hide');
    var seq=parseInt((String(d.no).match(/(\d+)$/)||[])[1]||'0',10); if(seq) localStorage.setItem('knap_quote_seq',String(seq));
    $('#stat').textContent='Saved.';
  }).catch(function(e){$('#stat').textContent='Save failed: '+e.message;});
}
function reviseQuote(){
  if(!editingId){ return saveQuote(); }
  var note=prompt('Optional note for this version (e.g. "after discussion — revised to 35,000"):','')||'';
  var d=gather(); d.note=note; $('#stat').textContent='Saving version…';
  api('/quotes/'+editingId+'/revise',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(function(j){
    $('#editBadge').textContent='saved · rev '+j.quote.rev; $('#editBadge').classList.remove('hide');
    $('#stat').textContent='Saved as revision '+j.quote.rev+'.';
  }).catch(function(e){$('#stat').textContent='Version save failed: '+e.message;});
}

/* ---------- list ---------- */
function coName(id){var c=companies.find(function(x){return x.id===id;});return c?c.name:id||'';}
function loadList(){
  api('/quotes').then(function(j){
    var b=$('#listBody'); b.innerHTML='';
    (j.quotes||[]).forEach(function(q){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+(q.no||'')+'</td><td>'+coName(q.companyId).replace(/ Private Limited$/,'')+'</td><td>'+((q.client&&q.client.name)||'')+'</td><td>'+(q.subject||'')+'</td>'
        +'<td style="text-align:right">'+money(q.total,'₹')+'</td><td>r'+(q.rev||1)+'</td><td><span class="st '+(q.status||'Draft')+'">'+(q.status||'Draft')+'</span></td>'
        +'<td class="muted">'+new Date(q.updatedAt).toLocaleDateString('en-GB')+'</td>'
        +'<td><span class="clk act-open">Open</span> · <span class="clk act-hist">History</span></td>';
      tr.querySelector('.act-open').addEventListener('click',function(){openQuote(q.id);});
      tr.querySelector('.act-hist').addEventListener('click',function(){showHistory(q.id);});
      b.appendChild(tr);
    });
    $('#listEmpty').textContent=(j.quotes||[]).length?'':'No quotations saved yet.';
  }).catch(function(e){$('#listEmpty').textContent='Could not load: '+e.message;});
}
function openQuote(id){
  api('/quotes/'+id).then(function(j){
    var q=j.quote, latest=q.revisions[q.revisions.length-1].data;
    editingId=id; show('New'); fill(latest);
    $('#editBadge').textContent='editing '+(q.no||'')+' · rev '+q.rev; $('#editBadge').classList.remove('hide'); $('#revise').classList.remove('hide');
    $('#stat').textContent='Loaded. "Save as new version" to add rev '+(q.rev+1)+'.';
  });
}
function showHistory(id){
  api('/quotes/'+id).then(function(j){
    var q=j.quote, b=$('#histBody'); b.innerHTML='';
    q.revisions.slice().reverse().forEach(function(r){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>r'+r.rev+'</td><td class="muted">'+new Date(r.at).toLocaleString('en-GB')+'</td><td style="text-align:right">'+money((r.data&&r.data.total)||0,(r.data&&r.data.currency)||'₹')+'</td><td>'+(r.note||'')+'</td><td><span class="clk">Load</span></td>';
      tr.querySelector('.clk').addEventListener('click',function(){ editingId=id; show('New'); fill(r.data); $('#histModal').classList.add('hide'); $('#editBadge').textContent='editing '+(q.no||'')+' · from rev '+r.rev; $('#editBadge').classList.remove('hide'); $('#revise').classList.remove('hide'); });
      b.appendChild(tr);
    });
    $('#histModal').classList.remove('hide');
  });
}

/* ---------- companies ---------- */
function loadCompanies(){
  return api('/companies').then(function(j){
    companies=j.companies||[];
    var sel=$('#companyId'); var cur=sel.value; sel.innerHTML=companies.map(function(c){return '<option value="'+c.id+'">'+c.name+'</option>';}).join('');
    if(cur) sel.value=cur; applyCompanyBank(); renderCoList();
  });
}
function renderCoList(){
  var b=$('#coBody'); b.innerHTML='';
  companies.forEach(function(c){
    var tr=document.createElement('tr');
    tr.innerHTML='<td>'+(c.logoFile?'<img src="'+API+'/companies/'+c.id+'/logo" style="height:26px">':'—')+'</td><td>'+c.name+'</td><td><span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:#'+(c.brand||'0070C0')+'"></span> #'+(c.brand||'')+'</td><td class="muted">'+((c.bank&&c.bank.ac)||'')+'</td><td><span class="clk act-edit">Edit</span> · <span class="clk act-del">Delete</span></td>';
    tr.querySelector('.act-edit').addEventListener('click',function(){openCoModal(c);});
    tr.querySelector('.act-del').addEventListener('click',function(){ if(confirm('Delete '+c.name+'?')) api('/companies/'+c.id,{method:'DELETE'}).then(loadCompanies); });
    b.appendChild(tr);
  });
}
function openCoModal(c){
  c=c||{bank:{}};
  $('#coTitle').textContent=c.id?'Edit company':'Add company';
  $('#c_id').value=c.id||''; $('#c_name').value=c.name||''; $('#c_tagline').value=c.tagline||''; $('#c_brand').value=c.brand||'0070C0';
  $('#c_brandPick').value='#'+String(c.brand||'0070C0').replace('#','');
  var b=c.bank||{}; ['ac','entity','ifsc','upi','terms','contact','phone','email'].forEach(function(k){$('#c_'+k).value=b[k]||'';});
  $('#c_logo').value=''; $('#coStat').textContent=''; $('#coModal').classList.remove('hide');
}
function saveCo(){
  var fd=new FormData();
  if($('#c_id').value) fd.append('id',$('#c_id').value);
  ['name','tagline','brand'].forEach(function(k){fd.append(k,$('#c_'+k).value.trim());});
  ['ac','entity','ifsc','upi','terms','contact','phone','email'].forEach(function(k){fd.append(k,$('#c_'+k).value.trim());});
  if($('#c_logo').files[0]) fd.append('logo',$('#c_logo').files[0]);
  $('#coStat').textContent='Saving…';
  fetch(API+'/companies',{method:'POST',body:fd}).then(function(r){return r.json();}).then(function(){ logoCache={}; return loadCompanies(); }).then(function(){ $('#coModal').classList.add('hide'); }).catch(function(e){$('#coStat').textContent='Failed: '+e.message;});
}

/* ---------- tabs ---------- */
function show(v){
  ['New','List','Co'].forEach(function(x){ $('#view'+x).classList.toggle('hide',x!==v); });
  $('#tabNew').classList.toggle('on',v==='New'); $('#tabList').classList.toggle('on',v==='List'); $('#tabCo').classList.toggle('on',v==='Co');
  if(v==='List') loadList(); if(v==='Co') renderCoList();
}

/* ---------- init ---------- */
$('#addRow').addEventListener('click',function(){$('#svcBody').appendChild(svcRow('',1,''));recompute();});
['gstOn','gstRate','gstMode','round','discMode','discVal','currency'].forEach(function(id){$('#'+id).addEventListener('input',recompute);});
$('#companyId').addEventListener('change',function(){ // switching company: overwrite bank + brand with that firm's details
  var co=companies.find(function(x){return x.id===$('#companyId').value;}); if(co){ document.documentElement.style.setProperty('--brand','#'+(co.brand||'0070C0')); }
  setCompanyBank(true); recompute();
});
$('#dl').addEventListener('click',downloadWord);
$('#dlpdf').addEventListener('click',downloadPdf);
$('#save').addEventListener('click',saveQuote);
$('#revise').addEventListener('click',reviseQuote);
$('#newBlank').addEventListener('click',newBlank);
$('#tabNew').addEventListener('click',function(){show('New');});
$('#tabList').addEventListener('click',function(){show('List');});
$('#tabCo').addEventListener('click',function(){show('Co');});
$('#histClose').addEventListener('click',function(){$('#histModal').classList.add('hide');});
$('#coAdd').addEventListener('click',function(){openCoModal(null);});
$('#c_brandPick').addEventListener('input',function(){ $('#c_brand').value=this.value.replace('#','').toUpperCase(); });
$('#c_brand').addEventListener('input',function(){ var h=this.value.replace(/[^0-9a-fA-F]/g,'').slice(0,6); if(h.length===6) $('#c_brandPick').value='#'+h; });
$('#coCancel').addEventListener('click',function(){$('#coModal').classList.add('hide');});
$('#coSave').addEventListener('click',saveCo);

loadCompanies().then(newBlank).catch(function(){ newBlank(); });
