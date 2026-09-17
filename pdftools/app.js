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
    +'<div class="fctl"><button class="x" title="Remove">✕</button></div>'
    +'<div class="mvbar"><button class="l" title="Move left">◀</button><button class="r" title="Move right">▶</button></div>';
  card.querySelector('.x').onclick=function(){ arr.splice(i,1); onChange(); };
  card.querySelector('.l').onclick=function(){ if(i>0){var t=arr[i-1];arr[i-1]=arr[i];arr[i]=t;onChange();} };
  card.querySelector('.r').onclick=function(){ if(i<arr.length-1){var t=arr[i+1];arr[i+1]=arr[i];arr[i]=t;onChange();} };
  return card;
}
function setPrev(card,url){ var p=card.querySelector('.prev'); p.innerHTML='<img src="'+url+'">'; }

/* drag-to-reorder: attach to any element that represents arr[pos] */
var _dragSrc=null;
function makeDraggable(el,pos,arr,onChange){
  el.draggable=true;
  el.addEventListener('dragstart',function(e){ _dragSrc=pos; try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(pos));}catch(_){} el.classList.add('dragging'); });
  el.addEventListener('dragend',function(){ el.classList.remove('dragging'); _dragSrc=null; });
  el.addEventListener('dragover',function(e){ if(_dragSrc==null)return; e.preventDefault(); e.dataTransfer.dropEffect='move'; el.classList.add('dragover'); });
  el.addEventListener('dragleave',function(){ el.classList.remove('dragover'); });
  el.addEventListener('drop',function(e){ e.preventDefault(); el.classList.remove('dragover'); if(_dragSrc==null||_dragSrc===pos)return; var it=arr.splice(_dragSrc,1)[0]; arr.splice(pos,0,it); _dragSrc=null; onChange(); });
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
      div.innerHTML='<canvas></canvas><div class="pg">page '+(i+1)+'</div><span class="badge" style="display:none"></span>';
      host.appendChild(div); sThumbEls[i]=div;
      pdf.getPage(i+1).then(function(page){ var base=page.rotate||0; var vp=page.getViewport({scale:0.32,rotation:base}); var cv=div.querySelector('canvas'); cv.width=vp.width; cv.height=vp.height; page.render({canvasContext:cv.getContext('2d'),viewport:vp}); });
    })(i); }
    paintSplit();
  }).catch(function(e){ host.innerHTML='<span class="muted">Preview unavailable: '+e.message+'</span>'; });
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
  sThumbEls.forEach(function(d){ if(!d)return; d.classList.remove('dim','sel-on'); d.style.boxShadow=''; var b=d.querySelector('.badge'); if(b){b.style.display='none';} });
  if(sSplitMode==='range'){
    var owner=[]; for(var k=0;k<sCount;k++) owner[k]=-1;
    plan.groups.forEach(function(g,gi){ g.idxs.forEach(function(pi){ if(pi>=0&&pi<sCount&&owner[pi]<0) owner[pi]=gi; }); });
    sThumbEls.forEach(function(d,pi){ if(!d)return; var gi=owner[pi]; var b=d.querySelector('.badge'); if(gi>=0){ var g=plan.groups[gi]; if(b){ b.textContent=g.label.replace('Range','R').replace('Part','P'); b.style.background=g.color; b.style.display=''; } d.style.boxShadow='0 0 0 2px '+g.color+' inset'; } else { d.classList.add('dim'); } });
  } else {
    var s={}; (plan._selected||[]).forEach(function(pi){ s[pi]=1; });
    sThumbEls.forEach(function(d,pi){ if(!d)return; if(s[pi]) d.classList.add('sel-on'); else d.classList.add('dim'); });
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
    div.innerHTML='<canvas></canvas><div class="pg">page '+(p.idx+1)+'</div><div class="tb"><button class="l">◀</button><button class="rl">⟲</button><button class="rr">⟳</button><button class="d">'+(p.del?'↺':'🗑')+'</button><button class="r">▶</button></div>';
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
