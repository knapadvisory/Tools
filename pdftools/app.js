/* PDF Toolkit — everything runs in the browser (pdf-lib + pdf.js + JSZip). */
var $=function(s){return document.querySelector(s);};
pdfjsLib.GlobalWorkerOptions.workerSrc='pdf.worker.min.js';
var PDFDocument=PDFLib.PDFDocument, degrees=PDFLib.degrees;

function dl(blob,name){ var u=URL.createObjectURL(blob),a=document.createElement('a'); a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){a.remove();URL.revokeObjectURL(u);},1500); }
function ab(file){ return file.arrayBuffer(); }
function u8(arrbuf){ return new Uint8Array(arrbuf.slice(0)); }
function bar(id,pct){ var w=$('#'+id); w.style.display='block'; w.firstElementChild.style.width=(pct==null?0:pct)+'%'; }
function hideBar(id){ $('#'+id).style.display='none'; }
function setupDrop(dropSel,fileSel,onFiles){
  var d=$(dropSel), f=$(fileSel);
  d.addEventListener('click',function(){f.click();});
  f.addEventListener('change',function(){ if(f.files.length) onFiles([].slice.call(f.files)); f.value=''; });
  ['dragenter','dragover'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.add('hot');});});
  ['dragleave','drop'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.remove('hot');});});
  d.addEventListener('drop',function(ev){ var fs=[].slice.call(ev.dataTransfer.files); if(fs.length) onFiles(fs); });
}
function loadPdfjs(bytes){ return pdfjsLib.getDocument({data:u8(bytes)}).promise; }

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tabs button').forEach(function(b){ b.addEventListener('click',function(){
  document.querySelectorAll('.tabs button').forEach(function(x){x.classList.toggle('on',x===b);});
  document.querySelectorAll('.view').forEach(function(v){v.classList.add('hide');});
  $('#v_'+b.dataset.v).classList.remove('hide');
});});

/* ---------------- MERGE ---------------- */
function renderFirstPage(f){
  return ab(f).then(function(a){ return loadPdfjs(a); }).then(function(pdf){ return pdf.getPage(1); }).then(function(page){
    var v0=page.getViewport({scale:1}); var vp=page.getViewport({scale:290/v0.height});
    var cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height;
    return page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise.then(function(){ return cv.toDataURL('image/jpeg',0.8); });
  });
}
function fileCard(name,i,arr,onChange){
  var card=document.createElement('div'); card.className='fcard';
  card.innerHTML='<div class="prev"><span class="ld">rendering…</span></div><div class="fn" title="'+name.replace(/"/g,'&quot;')+'">'+name+'</div>'
    +'<div class="fctl"><button class="x" title="Remove"><img src="ic-trash.png" draggable="false"></button></div>'
    +'<div class="mvbar"><button class="l" title="Move left"><img src="ic-left.png" draggable="false"></button><button class="r" title="Move right"><img src="ic-right.png" draggable="false"></button></div>';
  card.querySelector('.x').onclick=function(){ arr.splice(i,1); onChange(); };
  card.querySelector('.l').onclick=function(){ if(i>0){var t=arr[i-1];arr[i-1]=arr[i];arr[i]=t;onChange();} };
  card.querySelector('.r').onclick=function(){ if(i<arr.length-1){var t=arr[i+1];arr[i+1]=arr[i];arr[i]=t;onChange();} };
  return card;
}
function setPrev(card,url){ var p=card.querySelector('.prev'); p.innerHTML='<img src="'+url+'">'; }

/* drag-to-reorder: attach to any element that represents arr[pos].
   Shows a thick insertion bar on the side the item will land, so the drop target is unmistakable. */
var _dragSrc=null, _dropSide='before';
function clearDropMarks(){ document.querySelectorAll('.drop-before,.drop-after').forEach(function(x){x.classList.remove('drop-before','drop-after');}); }
function makeDraggable(el,pos,arr,onChange){
  el.draggable=true;
  el.addEventListener('dragstart',function(e){ _dragSrc=pos; try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(pos));}catch(_){} setTimeout(function(){el.classList.add('dragging');},0); });
  el.addEventListener('dragend',function(){ el.classList.remove('dragging'); clearDropMarks(); _dragSrc=null; });
  el.addEventListener('dragover',function(e){ if(_dragSrc==null)return; e.preventDefault(); e.dataTransfer.dropEffect='move';
    clearDropMarks();
    if(pos===_dragSrc) return;
    var r=el.getBoundingClientRect(); var after=(e.clientX-r.left) > r.width/2; _dropSide=after?'after':'before';
    el.classList.add(after?'drop-after':'drop-before');
  });
  el.addEventListener('dragleave',function(){ el.classList.remove('drop-before','drop-after'); });
  el.addEventListener('drop',function(e){ e.preventDefault(); clearDropMarks(); if(_dragSrc==null)return;
    var from=_dragSrc; var insert=pos+(_dropSide==='after'?1:0); if(from<insert) insert--;
    _dragSrc=null; if(insert===from||insert<0){ return; }
    var it=arr.splice(from,1)[0]; arr.splice(insert,0,it); onChange();
  });
}

var mFiles=[];
setupDrop('#mDrop','#mFile',function(fs){ fs.forEach(function(f){ if(f.type==='application/pdf'||/\.pdf$/i.test(f.name)) mFiles.push(f); }); renderM(); });
function renderM(){
  var host=$('#mList'); host.innerHTML='';
  mFiles.forEach(function(f,i){
    var card=fileCard(f.name,i,mFiles,renderM); makeDraggable(card,i,mFiles,renderM); host.appendChild(card);
    if(f._thumb) setPrev(card,f._thumb);
    else renderFirstPage(f).then(function(url){ f._thumb=url; setPrev(card,url); }).catch(function(){ card.querySelector('.prev').innerHTML='<span class="ld">PDF</span>'; });
  });
  $('#mGo').disabled=mFiles.length<1;
}
$('#mGo').addEventListener('click',function(){
  $('#mStat').textContent='Merging…'; bar('mBar',0);
  (async function(){
    var out=await PDFDocument.create();
    for(var i=0;i<mFiles.length;i++){
      var src=await PDFDocument.load(await ab(mFiles[i]),{ignoreEncryption:true});
      var pages=await out.copyPages(src, src.getPageIndices());
      pages.forEach(function(p){out.addPage(p);});
      bar('mBar',Math.round((i+1)/mFiles.length*100));
    }
    var bytes=await out.save();
    dl(new Blob([bytes],{type:'application/pdf'}),'merged.pdf'); hideBar('mBar'); $('#mStat').textContent=out.getPageCount()+' pages merged.';
  })().catch(function(e){ hideBar('mBar'); $('#mStat').textContent='Error: '+e.message; });
});

/* ---------------- SPLIT ---------------- */
var sBytes=null, sCount=0, sThumbEls=[];
var sSplitMode='range', sRangeKind='custom', sPagesKind='all';
var sRanges=[]; // [{from,to}]
var RCOL=['#1b6a3a','#2563eb','#b45309','#7c3aed','#be185d','#0e7490','#4d7c0f','#9d174d'];

function parseRange(str,max){
  var out=[], seen={};
  (str||'').split(',').forEach(function(part){ part=part.trim(); if(!part)return; var m=part.match(/^(\d+)\s*-\s*(\d+)$/); if(m){ var a=+m[1],b=+m[2]; for(var i=Math.min(a,b);i<=Math.max(a,b);i++) if(i>=1&&i<=max&&!seen[i]){seen[i]=1;out.push(i-1);} } else if(/^\d+$/.test(part)){ var n=+part; if(n>=1&&n<=max&&!seen[n]){seen[n]=1;out.push(n-1);} } });
  return out;
}
function clampPg(v){ var n=parseInt(v,10); if(isNaN(n))return 1; return Math.max(1,Math.min(sCount,n)); }
function segOn(sel,btn){ $(sel).querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===btn);}); }

setupDrop('#sDrop','#sFile',function(fs){
  var f=fs[0];
  ab(f).then(function(a){ sBytes=a; return PDFDocument.load(a,{ignoreEncryption:true}); }).then(function(doc){
    sCount=doc.getPageCount(); $('#sInfo').textContent=f.name+' — '+sCount+' pages';
    sRanges=[{from:1,to:sCount}];
    $('#sPanel').classList.remove('hide');
    renderRanges(); renderSThumbs(); refreshSplit();
  }).catch(function(e){ $('#sInfo').textContent='Could not read: '+e.message; $('#sPanel').classList.add('hide'); $('#sGo').disabled=true; });
});

$('#sMode2').addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b)return; sSplitMode=b.dataset.m; segOn('#sMode2',b); $('#sRangePane').classList.toggle('hide',sSplitMode!=='range'); $('#sPagesPane').classList.toggle('hide',sSplitMode!=='pages'); refreshSplit(); });
$('#sRangeKind').addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b)return; sRangeKind=b.dataset.k; segOn('#sRangeKind',b); $('#sCustomWrap').classList.toggle('hide',sRangeKind!=='custom'); $('#sFixedWrap').classList.toggle('hide',sRangeKind!=='fixed'); refreshSplit(); });
$('#sPagesKind').addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b)return; sPagesKind=b.dataset.k; segOn('#sPagesKind',b); $('#sSelectWrap').classList.toggle('hide',sPagesKind!=='select'); refreshSplit(); });
$('#sAddRange').addEventListener('click',function(){ sRanges.push({from:1,to:sCount}); renderRanges(); refreshSplit(); });
$('#sFixedN').addEventListener('input',refreshSplit);
$('#sPagesList').addEventListener('input',refreshSplit);
$('#sMergeRanges').addEventListener('change',refreshSplit);
$('#sMergePages').addEventListener('change',refreshSplit);

function renderRanges(){
  var host=$('#sRanges'); host.innerHTML='';
  sRanges.forEach(function(r,i){
    var row=document.createElement('div'); row.className='rrow';
    row.innerHTML='<span class="rn" style="color:'+RCOL[i%RCOL.length]+'">Range '+(i+1)+'</span>'
      +'<label>from</label><input type="number" class="rf" min="1" max="'+sCount+'" value="'+r.from+'">'
      +'<label>to</label><input type="number" class="rt" min="1" max="'+sCount+'" value="'+r.to+'">'
      +(sRanges.length>1?'<button class="del" title="Remove">✕</button>':'');
    row.querySelector('.rf').addEventListener('input',function(){ r.from=clampPg(this.value); refreshSplit(); });
    row.querySelector('.rt').addEventListener('input',function(){ r.to=clampPg(this.value); refreshSplit(); });
    var del=row.querySelector('.del'); if(del) del.onclick=function(){ sRanges.splice(i,1); renderRanges(); refreshSplit(); };
    host.appendChild(row);
  });
}
function renderSThumbs(){
  var host=$('#sThumbs'); host.innerHTML=''; sThumbEls=[];
  loadPdfjs(sBytes).then(function(pdf){
    for(var i=0;i<sCount;i++){ (function(i){
      var div=document.createElement('div'); div.className='thumb';
      div.innerHTML='<div class="tw"><canvas></canvas></div><div class="pg">page '+(i+1)+'</div><span class="badge" style="display:none"></span>';
      div.addEventListener('click',function(){ if(sSplitMode==='pages' && sPagesKind==='select') togglePageSelect(i+1); });
      host.appendChild(div); sThumbEls[i]=div;
      pdf.getPage(i+1).then(function(page){ var base=page.rotate||0; var vp=page.getViewport({scale:0.32,rotation:base}); var cv=div.querySelector('canvas'); cv.width=vp.width; cv.height=vp.height; page.render({canvasContext:cv.getContext('2d'),viewport:vp}); });
    })(i); }
    paintSplit();
  }).catch(function(e){ host.innerHTML='<span class="muted">Preview unavailable: '+e.message+'</span>'; });
}
function serializePages(nums){
  var out=[], i=0;
  while(i<nums.length){ var s=nums[i], e=s; while(i+1<nums.length && nums[i+1]===e+1){ e=nums[++i]; } out.push(s===e?String(s):(s+'-'+e)); i++; }
  return out.join(',');
}
function togglePageSelect(pageNo){
  var set={}; parseRange($('#sPagesList').value,sCount).forEach(function(pi){ set[pi+1]=1; });
  if(set[pageNo]) delete set[pageNo]; else set[pageNo]=1;
  var nums=Object.keys(set).map(Number).sort(function(a,b){return a-b;});
  $('#sPagesList').value=serializePages(nums);
  refreshSplit();
}

function computeSplitPlan(){
  var plan={groups:[], merge:false, valid:false, count:0, _selected:null};
  if(!sCount) return plan;
  if(sSplitMode==='range'){
    if(sRangeKind==='custom'){
      plan.merge=$('#sMergeRanges').checked;
      sRanges.forEach(function(r,i){ var a=Math.min(r.from,r.to),b=Math.max(r.from,r.to); var idxs=[]; for(var p=a;p<=b;p++) idxs.push(p-1); plan.groups.push({idxs:idxs,color:RCOL[i%RCOL.length],label:'Range '+(i+1)}); });
      plan.valid=plan.groups.length>0 && plan.groups.every(function(g){return g.idxs.length>0;});
    } else {
      var n=parseInt($('#sFixedN').value,10)||0;
      if(n>=1){ for(var s=0;s<sCount;s+=n){ var idxs2=[]; for(var p2=s;p2<Math.min(s+n,sCount);p2++) idxs2.push(p2); plan.groups.push({idxs:idxs2,color:RCOL[plan.groups.length%RCOL.length],label:'Part '+(plan.groups.length+1)}); } plan.valid=plan.groups.length>0; }
      plan.merge=false;
    }
  } else {
    plan.merge=$('#sMergePages').checked;
    var sel = sPagesKind==='all' ? (function(){var a=[];for(var p=0;p<sCount;p++)a.push(p);return a;})() : parseRange($('#sPagesList').value,sCount);
    plan._selected=sel;
    if(plan.merge){ if(sel.length){ plan.groups.push({idxs:sel,color:RCOL[0],label:'Extracted'}); plan.valid=true; } }
    else { sel.forEach(function(pi){ plan.groups.push({idxs:[pi],color:RCOL[0],label:'Page '+(pi+1)}); }); plan.valid=sel.length>0; }
  }
  plan.count = plan.merge ? 1 : plan.groups.length;
  return plan;
}
function paintSplit(){
  var plan=computeSplitPlan();
  sThumbEls.forEach(function(d){ if(!d)return; d.classList.remove('dim','sel-on','pick'); d.style.boxShadow=''; var b=d.querySelector('.badge'); if(b){b.style.display='none';} });
  var pickable = (sSplitMode==='pages' && sPagesKind==='select');
  if(sSplitMode==='range'){
    var owner=[]; for(var k=0;k<sCount;k++) owner[k]=-1;
    plan.groups.forEach(function(g,gi){ g.idxs.forEach(function(pi){ if(pi>=0&&pi<sCount&&owner[pi]<0) owner[pi]=gi; }); });
    sThumbEls.forEach(function(d,pi){ if(!d)return; var gi=owner[pi]; var b=d.querySelector('.badge'); if(gi>=0){ var g=plan.groups[gi]; if(b){ b.textContent=g.label.replace('Range','R').replace('Part','P'); b.style.background=g.color; b.style.display=''; } d.style.boxShadow='0 0 0 2px '+g.color+' inset'; } else { d.classList.add('dim'); } });
  } else {
    var s={}; (plan._selected||[]).forEach(function(pi){ s[pi]=1; });
    sThumbEls.forEach(function(d,pi){ if(!d)return; if(pickable) d.classList.add('pick'); if(s[pi]) d.classList.add('sel-on'); });
  }
}
function refreshSplit(){
  if(!sCount)return; paintSplit();
  var plan=computeSplitPlan(), h=$('#sHint');
  if(!plan.valid){ h.textContent='Set a valid range / page selection to continue.'; $('#sGo').disabled=true; return; }
  var n=plan.count;
  h.innerHTML = n===1 ? '<b>1 PDF</b> will be created.' : '<b>'+n+' PDFs</b> will be created (delivered as a ZIP).';
  $('#sGo').disabled=false;
}
$('#sGo').addEventListener('click',function(){
  var plan=computeSplitPlan();
  if(!plan.valid){ $('#sStat').textContent='Nothing to split.'; return; }
  $('#sStat').textContent='Splitting…'; bar('sBar',0);
  (async function(){
    var src=await PDFDocument.load(sBytes,{ignoreEncryption:true});
    async function build(idxs){ var d=await PDFDocument.create(); var ps=await d.copyPages(src,idxs); ps.forEach(function(p){d.addPage(p);}); return d.save(); }
    if(plan.merge){
      var all=[]; plan.groups.forEach(function(g){ all=all.concat(g.idxs); });
      dl(new Blob([await build(all)],{type:'application/pdf'}),'split.pdf'); hideBar('sBar'); $('#sStat').textContent=all.length+' pages → 1 PDF.'; return;
    }
    if(plan.groups.length===1){
      dl(new Blob([await build(plan.groups[0].idxs)],{type:'application/pdf'}),'split.pdf'); hideBar('sBar'); $('#sStat').textContent=plan.groups[0].idxs.length+' page(s) extracted.'; return;
    }
    var zip=new JSZip(), used={};
    for(var i=0;i<plan.groups.length;i++){
      var g=plan.groups[i]; var nm=g.label.toLowerCase().replace(/[^a-z0-9]+/g,'-'); if(used[nm]) nm+='-'+(i+1); used[nm]=1;
      zip.file(nm+'.pdf', await build(g.idxs)); bar('sBar',Math.round((i+1)/plan.groups.length*100));
    }
    dl(await zip.generateAsync({type:'blob'}),'split.zip'); hideBar('sBar'); $('#sStat').textContent=plan.groups.length+' PDFs → ZIP.';
  })().catch(function(e){ hideBar('sBar'); $('#sStat').textContent='Error: '+e.message; });
});

/* ---------------- ORGANISE ---------------- */
var oBytes=null, oPages=[]; // {idx, rot, del}
setupDrop('#oDrop','#oFile',function(fs){ var f=fs[0]; ab(f).then(function(a){ oBytes=a; return loadPdfjs(a); }).then(function(pdf){ oPages=[]; for(var i=0;i<pdf.numPages;i++) oPages.push({idx:i,rot:0,del:false}); renderOrg(pdf); $('#oActions').classList.remove('hide'); }).catch(function(e){$('#oStat').textContent='Could not read: '+e.message;}); });
function renderOrg(pdf){
  var host=$('#oThumbs'); host.innerHTML='';
  oPages.forEach(function(p,pos){
    var div=document.createElement('div'); div.className='thumb'+(p.del?' del':'');
    div.innerHTML='<div class="tw"><canvas></canvas></div><div class="pg">page '+(p.idx+1)+'</div>'
      +'<div class="tb">'
      +'<button class="l" title="Move left"><img src="ic-left.png" draggable="false"></button>'
      +'<button class="rl" title="Rotate left"><img src="ic-rot-l.svg" draggable="false"></button>'
      +'<button class="rr" title="Rotate right"><img src="ic-rot-r.svg" draggable="false"></button>'
      +'<button class="d" title="'+(p.del?'Restore':'Delete')+'"><img src="ic-trash.png" draggable="false"></button>'
      +'<button class="r" title="Move right"><img src="ic-right.png" draggable="false"></button>'
      +'</div>';
    makeDraggable(div,pos,oPages,function(){renderOrg(pdf);});
    host.appendChild(div);
    // render thumb
    pdf.getPage(p.idx+1).then(function(page){ var base=page.rotate||0; var vp=page.getViewport({scale:0.35,rotation:(base+p.rot)%360}); var cv=div.querySelector('canvas'); cv.width=vp.width; cv.height=vp.height; page.render({canvasContext:cv.getContext('2d'),viewport:vp}); });
    div.querySelector('.l').onclick=function(){ if(pos>0){ var t=oPages[pos-1];oPages[pos-1]=oPages[pos];oPages[pos]=t; renderOrg(pdf);} };
    div.querySelector('.r').onclick=function(){ if(pos<oPages.length-1){ var t=oPages[pos+1];oPages[pos+1]=oPages[pos];oPages[pos]=t; renderOrg(pdf);} };
    div.querySelector('.rl').onclick=function(){ p.rot=(p.rot+270)%360; renderOrg(pdf); };
    div.querySelector('.rr').onclick=function(){ p.rot=(p.rot+90)%360; renderOrg(pdf); };
    div.querySelector('.d').onclick=function(){ p.del=!p.del; renderOrg(pdf); };
  });
}
$('#oGo').addEventListener('click',function(){
  $('#oStat').textContent='Saving…';
  (async function(){
    var src=await PDFDocument.load(oBytes,{ignoreEncryption:true});
    var kept=oPages.filter(function(p){return !p.del;});
    if(!kept.length){ $('#oStat').textContent='All pages deleted — nothing to save.'; return; }
    var out=await PDFDocument.create();
    var copied=await out.copyPages(src, kept.map(function(p){return p.idx;}));
    copied.forEach(function(pg,i){ var add=out.addPage(pg); var cur=pg.getRotation().angle||0; if(kept[i].rot) pg.setRotation(degrees((cur+kept[i].rot)%360)); });
    dl(new Blob([await out.save()],{type:'application/pdf'}),'organised.pdf'); $('#oStat').textContent=kept.length+' pages saved.';
  })().catch(function(e){ $('#oStat').textContent='Error: '+e.message; });
});

/* ---------------- PDF → JPG ---------------- */
var jBytes=null, jCount=0;
setupDrop('#jDrop','#jFile',function(fs){ var f=fs[0]; ab(f).then(function(a){ jBytes=a; return loadPdfjs(a); }).then(function(pdf){ jCount=pdf.numPages; $('#jInfo').textContent=f.name+' — '+jCount+' pages'; $('#jGo').disabled=false; }).catch(function(e){$('#jInfo').textContent='Could not read: '+e.message;}); });
$('#jGo').addEventListener('click',function(){
  if(!jBytes)return; var scale=+$('#jScale').value; $('#jStat').textContent='Rendering…'; bar('jBar',0);
  (async function(){
    var pdf=await loadPdfjs(jBytes); var imgs=[];
    for(var i=1;i<=pdf.numPages;i++){
      var page=await pdf.getPage(i); var vp=page.getViewport({scale:scale});
      var cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height;
      await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
      var blob=await new Promise(function(res){cv.toBlob(res,'image/jpeg',0.92);});
      imgs.push(blob); bar('jBar',Math.round(i/pdf.numPages*100));
    }
    if(imgs.length===1){ dl(imgs[0],'page-1.jpg'); }
    else { var zip=new JSZip(); imgs.forEach(function(b,i){ zip.file('page-'+String(i+1).padStart(3,'0')+'.jpg', b); }); dl(await zip.generateAsync({type:'blob'}),'pdf-images.zip'); }
    hideBar('jBar'); $('#jStat').textContent=imgs.length+' image(s) created.';
  })().catch(function(e){ hideBar('jBar'); $('#jStat').textContent='Error: '+e.message; });
});

/* ---------------- JPG → PDF ---------------- */
var iFiles=[];
setupDrop('#iDrop','#iFile',function(fs){ fs.forEach(function(f){ if(/image\/(jpeg|png)/.test(f.type)||/\.(jpe?g|png)$/i.test(f.name)) iFiles.push(f); }); renderI(); });
function renderI(){
  var host=$('#iList'); host.innerHTML='';
  iFiles.forEach(function(f,i){
    var card=fileCard(f.name,i,iFiles,renderI); makeDraggable(card,i,iFiles,renderI); host.appendChild(card);
    if(!f._url) f._url=URL.createObjectURL(f);
    setPrev(card,f._url);
  });
  $('#iGo').disabled=iFiles.length<1;
}
$('#iGo').addEventListener('click',function(){
  $('#iStat').textContent='Building…'; bar('iBar',0);
  (async function(){
    var out=await PDFDocument.create(); var size=$('#iSize').value, margin=+$('#iMargin').value||0;
    var A4=[595.28,841.89];
    for(var i=0;i<iFiles.length;i++){
      var f=iFiles[i], bytes=await ab(f); var isPng=/png/i.test(f.type)||/\.png$/i.test(f.name);
      var img=isPng? await out.embedPng(bytes) : await out.embedJpg(bytes);
      if(size==='a4'){
        var page=out.addPage(A4); var mw=A4[0]-2*margin, mh=A4[1]-2*margin;
        var sc=Math.min(mw/img.width, mh/img.height); var w=img.width*sc, h=img.height*sc;
        page.drawImage(img,{x:(A4[0]-w)/2,y:(A4[1]-h)/2,width:w,height:h});
      } else {
        var p2=out.addPage([img.width,img.height]); p2.drawImage(img,{x:0,y:0,width:img.width,height:img.height});
      }
      bar('iBar',Math.round((i+1)/iFiles.length*100));
    }
    dl(new Blob([await out.save()],{type:'application/pdf'}),'images.pdf'); hideBar('iBar'); $('#iStat').textContent=iFiles.length+' image(s) → PDF.';
  })().catch(function(e){ hideBar('iBar'); $('#iStat').textContent='Error: '+e.message; });
});


/* ---------------- COMPRESS ----------------
   Two honest methods, and the page says which one costs what.

   · "structure"  re-saves through pdf-lib with object streams on. Text stays
                  text, so the file is still searchable and selectable, but the
                  saving is whatever the structure gives up — sometimes nothing.
   · "image"      renders each page and stores it as a JPEG at the ORIGINAL page
                  size, so printing is unchanged. This is where the big savings
                  are, and it is why the text layer goes: the page becomes a
                  picture of itself.

   MEMORY, because these files get big. Nothing holds a PDF's bytes: each file
   is read at the moment it is needed, handed straight to pdf.js (which keeps it
   in its worker, not on the main thread), and the document is destroyed the
   moment that file is finished. Files are processed ONE AT A TIME, so a queue
   of ten 200 MB scans never costs more than one of them. Page canvases are
   released as each page is encoded.

   Target mode searches for the best quality that still fits under a size the
   user names. It samples a few pages to find the setting quickly, then encodes
   the whole document and MEASURES it — a target is only ever reported as met
   against the real file, never against the estimate.              */

var cQueue=[], cOut=null, cOutName='', cStopFlag=false, cBusy=false;

var LEVELS = {                       // scale is relative to the page's own size
  light:    { scale: 1.50, q: 0.82 },
  balanced: { scale: 1.15, q: 0.72 },
  strong:   { scale: 0.90, q: 0.58 },
  max:      { scale: 0.70, q: 0.45 }
};
/* Ladder walked in target mode, biggest first: the first rung that fits wins,
   so the user gets the best quality that meets their size, not the smallest. */
var C_SCALES = [2.0, 1.6, 1.3, 1.15, 1.0, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3];
var C_QMIN = 0.20, C_QMAX = 0.92;
/* pdf-lib parses a whole document into JavaScript objects, which a very large
   file will not survive. Past this the structure method is refused with a
   reason rather than left to crash the tab. */
var C_STRUCT_MAX = 80*1024*1024;
var C_BIG = 60*1024*1024;            // past this, say what to expect

function fmtSize(b){
  if(b==null) return '';
  if(b < 1024) return b+' B';
  if(b < 1024*1024) return (b/1024).toFixed(b<10240?1:0)+' KB';
  return (b/(1024*1024)).toFixed(2)+' MB';
}
function greyscale(ctx,w,h){
  var d=ctx.getImageData(0,0,w,h), a=d.data;
  for(var i=0;i<a.length;i+=4){
    // Rec. 601 luma — the weighting the eye actually uses
    var y=(a[i]*0.299 + a[i+1]*0.587 + a[i+2]*0.114)|0;
    a[i]=a[i+1]=a[i+2]=y;
  }
  ctx.putImageData(d,0,0);
}
/* A fresh read, handed to pdf.js without copying. pdf.js moves the bytes into
   its worker, so the main thread is not left holding a second copy. */
async function cOpen(file){
  var buf=await file.arrayBuffer();
  return await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
}
function cYield(){ return new Promise(function(r){ setTimeout(r,0); }); }

/* One page → a JPEG, plus the page's true size in points so the rebuilt PDF
   prints exactly as the original does. */
async function cRenderPage(pdf,i,scale,quality,grey){
  var page=await pdf.getPage(i);
  var pt=page.getViewport({scale:1});                 // points, rotation applied
  var vp=page.getViewport({scale:scale});
  var cv=document.createElement('canvas');
  cv.width=Math.max(1,Math.round(vp.width)); cv.height=Math.max(1,Math.round(vp.height));
  var ctx=cv.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height);   // JPEG has no transparency
  await page.render({canvasContext:ctx,viewport:vp}).promise;
  if(grey) greyscale(ctx,cv.width,cv.height);
  var blob=await new Promise(function(res){ cv.toBlob(res,'image/jpeg',quality); });
  cv.width=cv.height=0;                                          // release the bitmap
  page.cleanup();                                                // and pdf.js's own page cache
  return { blob:blob, ptW:pt.width, ptH:pt.height };
}
/* Encode the whole document at one setting and return the real PDF bytes. */
async function cBuild(pdf,scale,quality,grey,onPct){
  var out=await PDFDocument.create();
  for(var i=1;i<=pdf.numPages;i++){
    if(cStopFlag) throw new Error('stopped');
    var r=await cRenderPage(pdf,i,scale,quality,grey);
    var img=await out.embedJpg(await r.blob.arrayBuffer());
    var pg=out.addPage([r.ptW,r.ptH]);
    pg.drawImage(img,{x:0,y:0,width:r.ptW,height:r.ptH});
    if(onPct) onPct(Math.round(i/pdf.numPages*100));
    if((i % 5)===0) await cYield();      // keep the page responsive on long runs
  }
  return await out.save();
}
/* The sample pages, drawn once per page size and kept. The quality search tries
   six or more qualities at one size; re-rendering for each would be the bulk of
   the work, while re-encoding a canvas already drawn is nearly free. */
var cCache={scale:null,grey:null,canvases:null};
function cFreeCache(){
  if(cCache.canvases) cCache.canvases.forEach(function(cv){ cv.width=cv.height=0; });
  cCache={scale:null,grey:null,canvases:null};
}
async function cSampleCanvases(pdf,sample,scale,grey){
  if(cCache.canvases && cCache.scale===scale && cCache.grey===grey) return cCache.canvases;
  cFreeCache();
  var arr=[];
  for(var k=0;k<sample.length;k++){
    var page=await pdf.getPage(sample[k]);
    var vp=page.getViewport({scale:scale});
    var cv=document.createElement('canvas');
    cv.width=Math.max(1,Math.round(vp.width)); cv.height=Math.max(1,Math.round(vp.height));
    var ctx=cv.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height);
    await page.render({canvasContext:ctx,viewport:vp}).promise;
    if(grey) greyscale(ctx,cv.width,cv.height);
    page.cleanup();
    arr.push(cv);
  }
  cCache={scale:scale,grey:grey,canvases:arr};
  return arr;
}
/* Roughly how big the whole document would be at this setting, judged from a
   few pages. Used only to CHOOSE a setting — never to report a result. */
async function cEstimate(pdf,sample,scale,quality,grey){
  var cvs=await cSampleCanvases(pdf,sample,scale,grey), sum=0;
  for(var k=0;k<cvs.length;k++){
    sum += (await new Promise(function(res){ cvs[k].toBlob(res,'image/jpeg',quality); })).size;
  }
  return (sum/cvs.length)*pdf.numPages + 1024*(2+pdf.numPages*0.06);   // + PDF overhead
}
/* The cheap search: walk the page-size ladder biggest first and, on the first
   rung that can reach the target, binary-search the JPEG quality. Biggest-first
   means the user gets the best quality that meets their size, not the smallest
   file that happens to fit. Where top quality already fits and the rung above
   could not fit at ANY quality, the gap between the two rungs is resolution
   going spare, so it is searched as well. */
async function cSearch(pdf,sample,target,grey,onPct){
  var chosen=null, tooBig=null;
  for(var si=0; si<C_SCALES.length && !chosen; si++){
    if(cStopFlag) throw new Error('stopped');
    var scale=C_SCALES[si];
    if(onPct) onPct(Math.round(si/C_SCALES.length*100));
    if(await cEstimate(pdf,sample,scale,C_QMAX,grey) <= target){ chosen={scale:scale,q:C_QMAX,spare:true}; break; }
    if(await cEstimate(pdf,sample,scale,C_QMIN,grey) > target){ tooBig=scale; continue; }
    var lo=C_QMIN, hi=C_QMAX;
    for(var it=0; it<6; it++){
      var mid=(lo+hi)/2;
      if(await cEstimate(pdf,sample,scale,mid,grey) <= target) lo=mid; else hi=mid;
    }
    chosen={scale:scale,q:lo};
  }
  if(!chosen) return { scale:C_SCALES[C_SCALES.length-1], q:C_QMIN };
  if(chosen.spare && tooBig && tooBig>chosen.scale){
    var loS=chosen.scale, hiS=tooBig;
    for(var j=0;j<5;j++){
      var midS=(loS+hiS)/2;
      if(await cEstimate(pdf,sample,midS,C_QMAX,grey) <= target) loS=midS; else hiS=midS;
    }
    chosen.scale=loS;
  }
  return chosen;
}
/* Pages sampled to judge a setting. Sampling costs a handful of renders;
   getting the estimate wrong costs a whole extra pass over the document, so a
   long document is sampled more widely — it is much the cheaper trade. */
function cSamplePages(n){
  if(n<=6){ var all=[]; for(var i=1;i<=n;i++) all.push(i); return all; }
  var k = n>120 ? 8 : (n>40 ? 6 : 4), out=[], seen={};
  for(var j=0;j<k;j++){
    var pg=Math.max(1,Math.min(n, Math.round(1 + j*(n-1)/(k-1))));
    if(!seen[pg]){ seen[pg]=1; out.push(pg); }
  }
  return out;
}

/* ---- the queue ---- */
setupDrop('#cDrop','#cFile',function(fs){
  fs.forEach(function(f){
    if(f.type==='application/pdf'||/\.pdf$/i.test(f.name)) cQueue.push({file:f,name:f.name,size:f.size,status:'',out:null});
  });
  cOut=null; $('#cResult').classList.add('hide'); $('#cStat').textContent='';
  cRenderQueue();
});
function cRenderQueue(){
  var host=$('#cList'); host.innerHTML='';
  cQueue.forEach(function(it,i){
    var li=document.createElement('li');
    li.innerHTML='<span class="nm" title="'+it.name.replace(/"/g,'&quot;')+'">'+it.name+'</span>'
      +'<span class="muted" style="white-space:nowrap">'+fmtSize(it.size)+'</span>'
      +'<span class="muted" style="min-width:190px;text-align:right">'+(it.status||'')+'</span>'
      +'<button class="x" title="Remove">✕</button>';
    li.querySelector('.x').onclick=function(){ if(cBusy) return; cQueue.splice(i,1); cRenderQueue(); };
    host.appendChild(li);
  });
  var total=cQueue.reduce(function(a,b){return a+b.size;},0);
  var biggest=cQueue.reduce(function(a,b){return Math.max(a,b.size);},0);
  $('#cInfo').innerHTML = cQueue.length
    ? '<b>'+cQueue.length+' file(s)</b>, '+fmtSize(total)+' in total.'
    : '';
  // A large file is slow, not impossible: say what to expect rather than
  // letting the tab sit there looking broken.
  var big=$('#cBig');
  if(biggest>=C_BIG){
    big.classList.remove('hide');
    big.innerHTML='The largest file here is <b>'+fmtSize(biggest)+'</b>. Files this size work, but they are read page by page and a few hundred pages can take several minutes '
      +'— leave the tab open and in the foreground (a background tab is throttled by the browser). '
      +'Files are handled one at a time, so a long queue costs no more memory than its biggest file. '
      +'If a file will not go through here, the <b>Advanced (server)</b> tool has no browser memory limit.';
  } else big.classList.add('hide');
  $('#cPanel').classList.toggle('hide', cQueue.length===0);
  $('#cGo').disabled = cQueue.length===0 || cBusy;
  if(cQueue.length) cUpdateHint();
}

document.querySelectorAll('#cMode button').forEach(function(b){ b.addEventListener('click',function(){
  document.querySelectorAll('#cMode button').forEach(function(x){x.classList.toggle('on',x===b);});
  $('#cLevelPane').classList.toggle('hide', b.dataset.m!=='level');
  $('#cTargetPane').classList.toggle('hide', b.dataset.m!=='target');
  cUpdateHint();
});});
['#cMethod','#cGrey','#cLevel'].forEach(function(sel){ var el=$(sel); if(el) el.addEventListener('change',cUpdateHint); });

function cMode(){ return document.querySelector('#cMode button.on').dataset.m; }
function cTargetBytes(){ return Math.max(1, (+$('#cTargetN').value||0)) * (+$('#cTargetU').value); }
function cUpdateHint(){
  var h=$('#cHint');
  if($('#cMethod').value==='structure'){
    h.innerHTML='The text stays selectable and searchable. Only the file’s structure is rewritten, so the saving is usually small — and on a file that is already tidy there may be none at all. '
      +'A size target cannot be honoured this way, and a file over '+fmtSize(C_STRUCT_MAX)+' is refused, because reading one whole into memory is what crashes the tab.';
  } else {
    h.innerHTML='Each page becomes a picture of itself at its original paper size, so it prints the same. <b>The text stops being selectable, searchable and copyable</b>, and so does anything a screen reader would read. Do not use this for a document someone must search — or keep the original alongside it.';
  }
}

/* ---- one file ---- */
async function cCompressOne(it,opts,onPct,onStat){
  if(opts.method==='structure'){
    if(it.size>C_STRUCT_MAX){
      return { skipped:true, why:'too large for the structure method ('+fmtSize(it.size)+' — the limit is '+fmtSize(C_STRUCT_MAX)+'). Use the image method, or the Advanced server tool.' };
    }
    var doc=await PDFDocument.load(new Uint8Array(await it.file.arrayBuffer()),{ignoreEncryption:true});
    var bytes=await doc.save({useObjectStreams:true});
    onPct(100);
    return { bytes:bytes, note: bytes.length>=it.size
      ? 'No reduction was possible without re-encoding — already compactly stored.'
      : 'Text still selectable and searchable.' };
  }

  var pdf=await cOpen(it.file);
  try{
    it.pages=pdf.numPages;
    if(opts.mode==='level'){
      var L=LEVELS[opts.level]||LEVELS.balanced;
      return { bytes:await cBuild(pdf,L.scale,L.q,opts.grey,onPct), pages:pdf.numPages,
               note:'Pages rebuilt as images — text no longer selectable.' };
    }

    /* ---- target size ----
       Two passes. The cheap sample search picks a setting; the whole document
       is then encoded and MEASURED. If the measurement disagrees with the
       estimate, the estimator is CALIBRATED against that real result and the
       search is run again — rather than nudging quality down a fixed step,
       which overshoots and hands back a file far under the size asked for.  */
    var target=opts.target, sample=cSamplePages(pdf.numPages);
    onStat('Looking for the best quality that fits…');
    var chosen=await cSearch(pdf,sample,target,opts.grey,function(p){onPct(Math.round(p*0.25));});

    onStat('Compressing…');
    var best=await cBuild(pdf,chosen.scale,chosen.q,opts.grey,function(p){onPct(25+Math.round(p*0.45));});

    /* Each correcting pass re-encodes the WHOLE document. On a long document
       that is minutes, and the wider sample above makes the first estimate
       good enough that a second correction rarely earns its cost. */
    var maxPasses = pdf.numPages>150 ? 1 : 2;
    for(var pass=0; pass<maxPasses; pass++){
      var over = best.length > target;
      var wasteful = best.length < target*0.72;        // quality given away for nothing
      if(!over && !wasteful) break;
      var est=await cEstimate(pdf,sample,chosen.scale,chosen.q,opts.grey);
      var k=best.length/Math.max(1,est);               // how wrong the estimate was
      if(!isFinite(k) || k<=0) break;
      var next=await cSearch(pdf,sample,target/k,opts.grey,null);
      if(next.scale===chosen.scale && Math.abs(next.q-chosen.q)<0.005) break;
      onStat(over ? 'Just over — adjusting…' : 'Room to spare — raising the quality…');
      var cand=await cBuild(pdf,next.scale,next.q,opts.grey,function(p){onPct(70+Math.round(p*0.28));});
      // Keep a candidate only if it is an improvement: fits when the old one
      // did not, or fits and is closer to the size the user asked for.
      if(cand.length<=target && (best.length>target || cand.length>best.length)){ best=cand; chosen=next; }
      else if(best.length>target && cand.length<best.length){ best=cand; chosen=next; }
      else break;
    }
    return { bytes:best, target:target, pages:pdf.numPages,
             note:'Pages rebuilt as images — text no longer selectable.' };
  } finally {
    cFreeCache();
    try{ await pdf.destroy(); }catch(_){ }   // hand the worker's copy back at once
  }
}

/* ---- the run ---- */
$('#cStop').addEventListener('click',function(){ cStopFlag=true; $('#cStat').textContent='Stopping…'; });

$('#cGo').addEventListener('click',function(){
  if(!cQueue.length||cBusy) return;
  var opts={ method:$('#cMethod').value, grey:$('#cGrey').checked, mode:cMode(),
             level:$('#cLevel').value, target:cTargetBytes() };
  cBusy=true; cStopFlag=false; cOut=null;
  $('#cResult').classList.add('hide'); $('#cGo').disabled=true; $('#cStop').style.display='';
  bar('cBar',0);

  (async function(){
    var done=[], t0=Date.now();
    for(var i=0;i<cQueue.length;i++){
      if(cStopFlag) break;
      var it=cQueue[i];
      var label=cQueue.length>1 ? ('File '+(i+1)+' of '+cQueue.length+' — ') : '';
      it.status='working…'; cRenderQueue();
      $('#cStat').textContent=label+it.name;
      /* jshint loopfunc:true */
      var base=i, n=cQueue.length;
      var r;
      try{
        r=await cCompressOne(it,opts,
          function(p){ bar('cBar', Math.round(((base+p/100)/n)*100)); },
          function(msg){ $('#cStat').textContent=label+msg; });
      }catch(e){
        if(/stopped/.test(e.message)){ it.status='stopped'; cRenderQueue(); break; }
        it.status='failed: '+e.message; cRenderQueue(); done.push({it:it,error:e.message}); continue;
      }
      if(r.skipped){ it.status='skipped'; done.push({it:it,error:r.why}); cRenderQueue(); continue; }
      it.out=new Blob([r.bytes],{type:'application/pdf'});
      it.newSize=r.bytes.length; it.target=r.target; it.note=r.note;
      var pc=it.size? Math.round((it.size-it.newSize)/it.size*100) : 0;
      it.status=fmtSize(it.newSize)+(it.newSize<it.size?(' · '+pc+'% smaller'):' · no saving')
        +(r.target!=null ? (it.newSize<=r.target?' · under target':' · OVER target') : '');
      cRenderQueue();
      done.push({it:it});
      await cYield();
    }
    return { done:done, secs:Math.round((Date.now()-t0)/1000) };
  })().then(async function(res){
    hideBar('cBar'); cBusy=false; $('#cGo').disabled=false; $('#cStop').style.display='none'; $('#cStat').textContent='';
    var ok=res.done.filter(function(d){return !d.error;});
    if(!ok.length){
      $('#cResultText').innerHTML='<span style="color:#b42318">Nothing was produced.</span>'
        +(res.done.length? '<div class="muted" style="margin-top:6px">'+res.done.map(function(d){return d.it.name+' — '+d.error;}).join('<br>')+'</div>' : '');
      $('#cResult').classList.remove('hide'); $('#cDl').style.display='none';
      return;
    }
    $('#cDl').style.display='';
    var inSum=ok.reduce(function(a,d){return a+d.it.size;},0);
    var outSum=ok.reduce(function(a,d){return a+d.it.newSize;},0);
    var pct=inSum? Math.round((inSum-outSum)/inSum*100) : 0;
    var head;
    if(ok.length===1){
      var d=ok[0];
      head='<b>'+fmtSize(d.it.size)+' → '+fmtSize(d.it.newSize)+'</b> — '
        +(d.it.newSize<d.it.size ? pct+'% smaller.' : '<span style="color:#b42318">no smaller than the original.</span>');
      if(d.it.target!=null){
        head += d.it.newSize<=d.it.target
          ? ' It is under your target of '+fmtSize(d.it.target)+'.'
          : ' <span style="color:#b42318">It is still over your target of '+fmtSize(d.it.target)+'. This is the smallest this document goes while remaining readable — splitting it is the only way further down.</span>';
      }
      cOut=d.it.out; cOutName=d.it.name.replace(/\.pdf$/i,'')+'-compressed.pdf';
      $('#cResultText').innerHTML=head+'<div class="muted" style="margin-top:6px">'+d.it.note+'</div>';
    } else {
      var missed=ok.filter(function(d){return d.it.target!=null && d.it.newSize>d.it.target;});
      head='<b>'+ok.length+' file(s): '+fmtSize(inSum)+' → '+fmtSize(outSum)+'</b> — '+pct+'% smaller overall, in '+res.secs+'s.';
      if(missed.length) head+=' <span style="color:#b42318">'+missed.length+' did not reach the target: '+missed.map(function(d){return d.it.name;}).join(', ')+'.</span>';
      var zip=new JSZip();
      for(var i=0;i<ok.length;i++) zip.file(ok[i].it.name.replace(/\.pdf$/i,'')+'-compressed.pdf', ok[i].it.out);
      $('#cStat').textContent='Packing the ZIP…';
      cOut=await zip.generateAsync({type:'blob'});
      cOutName='compressed-pdfs.zip'; $('#cStat').textContent='';
      $('#cResultText').innerHTML=head+'<div class="muted" style="margin-top:6px">'+ok[0].it.note+'</div>';
    }
    var bad=res.done.filter(function(d){return d.error;});
    if(bad.length) $('#cResultText').innerHTML+='<div class="muted" style="margin-top:6px;color:#b42318">'
      +bad.map(function(d){return d.it.name+' — '+d.error;}).join('<br>')+'</div>';
    $('#cResult').classList.remove('hide');
  }).catch(function(e){
    cFreeCache(); hideBar('cBar'); cBusy=false; $('#cGo').disabled=false; $('#cStop').style.display='none';
    $('#cStat').textContent='Error: '+e.message;
  });
});

$('#cDl').addEventListener('click',function(){ if(cOut) dl(cOut,cOutName); });

/* ---------------- EXCEL → PDF ----------------
   A workbook holds values, widths, merges and formats. This lays those out as
   a printable table — it does NOT try to be a picture of Excel. Charts, images,
   conditional formatting, fills and exact fonts are not reproduced, and the
   page says so rather than letting the output imply otherwise.

   ExcelJS is ~1 MB, so it is fetched only when this tab is actually used. */

var xWb=null, xName='', xSheets=[];
var X_PAPER={ a4:[595.28,841.89], a3:[841.89,1190.55], letter:[612,792], legal:[612,1008] };
var X_MARGIN=28;

function xLoadExcelJs(){
  if(window.ExcelJS) return Promise.resolve();
  return new Promise(function(ok,err){
    var sc=document.createElement('script');
    sc.src='/gstr2b/exceljs.js'; sc.onload=ok; sc.onerror=function(){err(new Error('could not load the spreadsheet library'));};
    document.head.appendChild(sc);
  });
}

/* Excel's column width is measured in characters of the default font; the
   usual conversion is px = chars*7 + 5, and PDF points are px*72/96. */
function xColPoints(w){ return ((w==null?10:w)*7+5)*0.75; }

/* Enough of Excel's number formats to print a schedule correctly: dates, and
   numbers with the thousands separator and decimal places the sheet asks for.
   Anything else is printed as the value reads — never invented. */
function xFormat(v,numFmt){
  if(v==null||v==='') return '';
  if(v instanceof Date){
    var d=v, p=function(n){return String(n).padStart(2,'0');};
    return p(d.getDate())+'-'+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]+'-'+d.getFullYear();
  }
  if(typeof v==='object'){
    if(v.richText) return v.richText.map(function(t){return t.text;}).join('');
    if('result' in v) return xFormat(v.result,numFmt);        // a formula: its saved result
    if(v.formula!=null) return '';                            // saved without calculating
    if(v.text!=null) return String(v.text);                   // hyperlink
    if(v.error) return String(v.error);
    return '';
  }
  if(typeof v==='number'){
    var f=String(numFmt||'');
    if(/[dmy]/i.test(f) && /[dmy]{2}/i.test(f)){              // a date serial
      var ms=Date.UTC(1899,11,30)+Math.round(v*86400000);
      return xFormat(new Date(ms),null);
    }
    var dec=0, m=f.match(/\.(0+)/); if(m) dec=m[1].length;
    var pct=/%/.test(f);
    var n=pct? v*100 : v;
    var out=n.toLocaleString('en-IN',{minimumFractionDigits:dec,maximumFractionDigits:dec});
    if(/\(#|\(0/.test(f) && n<0) out='('+out.replace('-','')+')';
    return pct? out+'%' : out;
  }
  if(typeof v==='boolean') return v?'TRUE':'FALSE';
  return String(v);
}
/* Break a string to fit a width, on spaces where possible and mid-word when a
   single token is longer than the column. */
function xWrap(text,font,size,maxW){
  var words=String(text).split(/\s+/), lines=[], cur='';
  var W=function(t){ try{ return font.widthOfTextAtSize(t,size); }catch(_){ return t.length*size*0.5; } };
  function pushLong(w){
    var s='';
    for(var i=0;i<w.length;i++){
      if(W(s+w[i])>maxW && s){ lines.push(s); s=w[i]; } else s+=w[i];
    }
    cur=s;
  }
  for(var i=0;i<words.length;i++){
    var w=words[i]; if(!w) continue;
    var trial=cur?cur+' '+w:w;
    if(W(trial)<=maxW){ cur=trial; continue; }
    if(cur){ lines.push(cur); cur=''; }
    if(W(w)>maxW) pushLong(w); else cur=w;
  }
  if(cur) lines.push(cur);
  return lines.length?lines:[''];
}
/* pdf-lib's standard fonts are WinAnsi: a rupee sign or a smart quote throws.
   Substitute rather than fail the whole document over one glyph. */
function xSafe(t){
  return String(t)
    .replace(/₹/g,'Rs.').replace(/[‘’]/g,"'").replace(/[“”]/g,'"')
    .replace(/[–—]/g,'-').replace(/…/g,'...').replace(/ /g,' ')
    .replace(/[^\x09\x0a\x0d\x20-\xff]/g,'?');
}

setupDrop('#xDrop','#xFile',function(fs){
  var f=fs[0]; if(!f) return;
  xName=f.name; $('#xStat').textContent=''; $('#xGo').disabled=true;
  $('#xInfo').textContent='Reading…';
  xLoadExcelJs().then(function(){ return f.arrayBuffer(); }).then(async function(buf){
    var wb=new ExcelJS.Workbook();
    if(/\.csv$/i.test(f.name)){
      var text=new TextDecoder().decode(new Uint8Array(buf));
      var ws=wb.addWorksheet(f.name.replace(/\.csv$/i,'').slice(0,28)||'Sheet1');
      text.split(/\r?\n/).forEach(function(line){
        if(line==='') return;
        // split on commas outside quotes
        var cells=[], cur='', q=false;
        for(var i=0;i<line.length;i++){
          var ch=line[i];
          if(ch==='"'){ if(q&&line[i+1]==='"'){cur+='"';i++;} else q=!q; }
          else if(ch===','&&!q){ cells.push(cur); cur=''; }
          else cur+=ch;
        }
        cells.push(cur);
        ws.addRow(cells.map(function(c){ var n=Number(c); return (c!==''&&isFinite(n))?n:c; }));
      });
    } else {
      await wb.xlsx.load(buf);
    }
    xWb=wb; xSheets=[];
    wb.eachSheet(function(ws){ xSheets.push({ name:ws.name, rows:ws.actualRowCount||ws.rowCount||0, on:true }); });
    if(!xSheets.length) throw new Error('this workbook has no sheets');
    $('#xSheets').innerHTML=xSheets.map(function(s,i){
      return '<label class="chk" style="margin:0"><input type="checkbox" data-xs="'+i+'" checked> '
        +s.name.replace(/[&<>]/g,'')+' <span class="muted">('+s.rows+' rows)</span></label>';
    }).join('');
    $('#xSheets').querySelectorAll('[data-xs]').forEach(function(cb){
      cb.addEventListener('change',function(){ xSheets[+cb.dataset.xs].on=cb.checked;
        $('#xGo').disabled=!xSheets.some(function(s){return s.on;}); });
    });
    $('#xInfo').innerHTML='<b>'+f.name+'</b> — '+xSheets.length+' sheet(s), '+fmtSize(f.size);
    $('#xPanel').classList.remove('hide'); $('#xGo').disabled=false;
  }).catch(function(e){
    var msg=e.message||String(e);
    if(/\.xls$/i.test(f.name)) msg='this is a legacy .xls file, which cannot be read here — open it in Excel and save as .xlsx';
    $('#xInfo').textContent='Could not read: '+msg;
    $('#xPanel').classList.add('hide'); $('#xGo').disabled=true;
  });
});

$('#xGo').addEventListener('click',function(){
  if(!xWb) return;
  $('#xStat').textContent='Building…'; bar('xBar',0); $('#xGo').disabled=true;
  (async function(){
    var paper=X_PAPER[$('#xPaper').value]||X_PAPER.a4;
    var orient=$('#xOrient').value, fitMode=$('#xFit').value;
    var size=+$('#xFont').value||8, grid=$('#xGrid').checked, repHead=$('#xHead').checked, titles=$('#xTitle').checked;

    var out=await PDFDocument.create();
    var font=await out.embedFont(PDFLib.StandardFonts.Helvetica);
    var bold=await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
    var wanted=xSheets.filter(function(s){return s.on;});
    var uncalculated=0, pagesMade=0;

    for(var si=0; si<wanted.length; si++){
      var ws=xWb.getWorksheet(wanted[si].name);
      if(!ws) continue;

      /* ---- read the sheet into a grid of {text,bold,align,span} ---- */
      var lastCol=Math.max(1, ws.actualColumnCount||ws.columnCount||1);
      var explicit=[]; for(var c=1;c<=lastCol;c++) explicit.push((ws.getColumn(c)||{}).width);
      var skip={};                                   // "r,c" covered by a merge
      var rows=[];
      ws.eachRow({includeEmpty:true},function(row,rn){
        var cells=[];
        for(var c=1;c<=lastCol;c++){
          if(skip[rn+','+c]){ cells.push(null); continue; }
          var cell=row.getCell(c);
          var span=1;
          if(cell.isMerged && cell.master && cell.master.address===cell.address){
            // a merged block: find how far right it runs, and mask the rest
            var m=(ws.model.merges||[]).find(function(x){ return x.split(':')[0]===cell.address; });
            if(m){
              var a=m.split(':'), c2=xColOf(a[1]), r2=parseInt(a[1].replace(/[A-Z]+/gi,''),10);
              span=Math.max(1,c2-c+1);
              for(var rr=rn;rr<=r2;rr++) for(var cc=c;cc<=c2;cc++) if(!(rr===rn&&cc===c)) skip[rr+','+cc]=1;
            }
          } else if(cell.isMerged){ cells.push(null); continue; }
          var raw=cell.value;
          if(raw && typeof raw==='object' && raw.formula!=null && !('result' in raw)) uncalculated++;
          var txt=xSafe(xFormat(raw,cell.numFmt));
          var al=(cell.alignment&&cell.alignment.horizontal)||null;
          cells.push({ text:txt, bold:!!(cell.font&&cell.font.bold), span:span,
                       align: al || (typeof raw==='number' ? 'right' : 'left') });
        }
        rows.push(cells);
      });
      // drop trailing empty rows
      while(rows.length && rows[rows.length-1].every(function(x){return !x||!x.text;})) rows.pop();
      if(!rows.length) continue;

      /* A column the sheet never sized — every column of a CSV — is measured
         from what is actually in it. Excel's own widths still win where they
         are set. A merged title is ignored: it spans the table and would make
         the first column absurdly wide. */
      var widths=[];
      for(var ci2=0; ci2<lastCol; ci2++){
        if(explicit[ci2]!=null){ widths.push(xColPoints(explicit[ci2])); continue; }
        var maxW=0, looked=0;
        for(var ri2=0; ri2<rows.length && looked<400; ri2++){
          var cl=rows[ri2][ci2];
          if(!cl||!cl.text||cl.span>1) continue;
          looked++;
          var w2=(cl.bold?bold:font).widthOfTextAtSize(cl.text,size);
          if(w2>maxW) maxW=w2;
        }
        widths.push(Math.min(Math.max(maxW+10, 30), 300));   // floor ~0.4in, ceiling ~4in
      }

      /* ---- page geometry ---- */
      var totalW=widths.reduce(function(a,b){return a+b;},0);
      var land = orient==='landscape' || (orient==='auto' && totalW > paper[0]-2*X_MARGIN);
      var pw = land? paper[1] : paper[0], ph = land? paper[0] : paper[1];
      var availW = pw-2*X_MARGIN;
      var colW = widths.slice(), scale=1;
      if(fitMode==='width' && totalW>availW){ scale=availW/totalW; colW=widths.map(function(w){return w*scale;}); }
      var fsize=Math.max(5, size*(scale<1?Math.max(0.7,scale):1));

      /* columns are cut into bands that each fit a page when not shrinking */
      var bands=[];
      if(fitMode==='width'){ bands=[{from:0,to:colW.length-1}]; }
      else {
        var b={from:0,to:0}, acc=0;
        for(var ci=0;ci<colW.length;ci++){
          if(acc+colW[ci]>availW && ci>b.from){ b.to=ci-1; bands.push(b); b={from:ci,to:ci}; acc=0; }
          acc+=colW[ci]; b.to=ci;
        }
        bands.push(b);
      }

      var lineH=fsize*1.35, pad=3;
      for(var bi=0; bi<bands.length; bi++){
        var band=bands[bi], page=null, y=0, pageNo=0;
        var headerRow = repHead? rows[0] : null;

        var newPage=function(){
          page=out.addPage([pw,ph]); pagesMade++; pageNo++;
          y=ph-X_MARGIN;
          if(titles){
            var t=wanted[si].name+(bands.length>1?(' — columns '+(band.from+1)+'–'+(band.to+1)):'');
            page.drawText(xSafe(t),{x:X_MARGIN,y:y-9,size:9,font:bold,color:PDFLib.rgb(0.09,0.25,0.16)});
            var lbl='Page '+pageNo;
            page.drawText(lbl,{x:pw-X_MARGIN-font.widthOfTextAtSize(lbl,8),y:y-9,size:8,font:font,color:PDFLib.rgb(0.45,0.45,0.45)});
            y-=20;
          }
        };
        var drawRow=function(cells,isHead){
          // height first, so a wrapped cell does not overrun the page
          var h=lineH, laid=[];
          var x=X_MARGIN;
          for(var ci=band.from; ci<=band.to; ci++){
            var cell=cells[ci];
            var w=colW[ci];
            if(cell && cell.span>1){ for(var k=1;k<cell.span && ci+k<=band.to;k++) w+=colW[ci+k]; }
            if(cell && cell.text){
              var ls=xWrap(cell.text,cell.bold?bold:font,fsize,Math.max(6,w-2*pad));
              h=Math.max(h,ls.length*lineH);
              laid.push({x:x,w:w,lines:ls,bold:cell.bold,align:cell.align});
            } else laid.push({x:x,w:w,lines:[],align:'left'});
            x+=w;
            if(cell && cell.span>1) ci+=cell.span-1;
          }
          if(y-h < X_MARGIN){ newPage(); if(headerRow && !isHead) drawRow(headerRow,true); }
          for(var li=0; li<laid.length; li++){
            var L=laid[li];
            for(var j=0;j<L.lines.length;j++){
              var f2=(isHead||L.bold)?bold:font, txt=L.lines[j];
              var tw=f2.widthOfTextAtSize(txt,fsize);
              var tx = L.align==='right' ? L.x+L.w-pad-tw : (L.align==='center' ? L.x+(L.w-tw)/2 : L.x+pad);
              page.drawText(txt,{x:tx,y:y-lineH+3-(j*lineH),size:fsize,font:f2,color:PDFLib.rgb(0.1,0.12,0.15)});
            }
            if(grid) page.drawRectangle({x:L.x,y:y-h,width:L.w,height:h,borderWidth:0.4,
              borderColor:PDFLib.rgb(0.80,0.83,0.80),color:isHead?PDFLib.rgb(0.93,0.96,0.94):undefined,opacity:isHead?1:0});
          }
          y-=h;
        };

        newPage();
        if(headerRow) drawRow(headerRow,true);
        for(var ri=(headerRow?1:0); ri<rows.length; ri++){
          drawRow(rows[ri],false);
          if((ri%40)===0){ bar('xBar',Math.round(((si+ (bi+ri/rows.length)/bands.length)/wanted.length)*100)); await cYield(); }
        }
      }
    }

    if(!pagesMade) throw new Error('nothing to print — the chosen sheets are empty');
    var bytes=await out.save();
    dl(new Blob([bytes],{type:'application/pdf'}), xName.replace(/\.(xlsx|xlsm|csv)$/i,'')+'.pdf');
    hideBar('xBar'); $('#xGo').disabled=false;
    $('#xStat').innerHTML=pagesMade+' page(s) created.'
      +(uncalculated? ' <span style="color:#b42318">'+uncalculated+' formula cell(s) were blank because the workbook was saved without calculating — open it in Excel, press F9, save, and try again.</span>' : '');
  })().catch(function(e){
    hideBar('xBar'); $('#xGo').disabled=false; $('#xStat').textContent='Error: '+e.message;
  });
});
/* "BC12" → 55 */
function xColOf(addr){
  var m=String(addr).match(/^([A-Z]+)/i); if(!m) return 1;
  var s=m[1].toUpperCase(), n=0;
  for(var i=0;i<s.length;i++) n=n*26+(s.charCodeAt(i)-64);
  return n;
}
