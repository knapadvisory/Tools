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
var mFiles=[];
setupDrop('#mDrop','#mFile',function(fs){ fs.forEach(function(f){ if(f.type==='application/pdf'||/\.pdf$/i.test(f.name)) mFiles.push(f); }); renderM(); });
function renderM(){
  var ul=$('#mList'); ul.innerHTML='';
  mFiles.forEach(function(f,i){
    var li=document.createElement('li');
    li.innerHTML='<span class="nm">'+(i+1)+'. '+f.name+'</span><button class="mv up">▲</button><button class="mv dn">▼</button><button class="x">✕</button>';
    li.querySelector('.up').onclick=function(){ if(i>0){ var t=mFiles[i-1];mFiles[i-1]=mFiles[i];mFiles[i]=t;renderM(); } };
    li.querySelector('.dn').onclick=function(){ if(i<mFiles.length-1){ var t=mFiles[i+1];mFiles[i+1]=mFiles[i];mFiles[i]=t;renderM(); } };
    li.querySelector('.x').onclick=function(){ mFiles.splice(i,1);renderM(); };
    ul.appendChild(li);
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
var sBytes=null, sCount=0;
setupDrop('#sDrop','#sFile',function(fs){ var f=fs[0]; ab(f).then(function(a){ sBytes=a; return PDFDocument.load(a,{ignoreEncryption:true}); }).then(function(doc){ sCount=doc.getPageCount(); $('#sInfo').textContent=f.name+' — '+sCount+' pages'; $('#sGo').disabled=false; }).catch(function(e){$('#sInfo').textContent='Could not read: '+e.message;}); });
$('#sMode').addEventListener('change',function(){ $('#sRangeWrap').classList.toggle('hide',$('#sMode').value!=='range'); });
function parseRange(str,max){
  var out=[], seen={};
  (str||'').split(',').forEach(function(part){ part=part.trim(); if(!part)return; var m=part.match(/^(\d+)\s*-\s*(\d+)$/); if(m){ var a=+m[1],b=+m[2]; for(var i=Math.min(a,b);i<=Math.max(a,b);i++) if(i>=1&&i<=max&&!seen[i]){seen[i]=1;out.push(i-1);} } else if(/^\d+$/.test(part)){ var n=+part; if(n>=1&&n<=max&&!seen[n]){seen[n]=1;out.push(n-1);} } });
  return out;
}
$('#sGo').addEventListener('click',function(){
  if(!sBytes)return; $('#sStat').textContent='Splitting…'; bar('sBar',0);
  (async function(){
    var src=await PDFDocument.load(sBytes,{ignoreEncryption:true});
    if($('#sMode').value==='range'){
      var idx=parseRange($('#sRange').value,sCount);
      if(!idx.length){ $('#sStat').textContent='Enter valid pages (1-'+sCount+').'; hideBar('sBar'); return; }
      var out=await PDFDocument.create(); var ps=await out.copyPages(src,idx); ps.forEach(function(p){out.addPage(p);});
      dl(new Blob([await out.save()],{type:'application/pdf'}),'extract.pdf'); hideBar('sBar'); $('#sStat').textContent=idx.length+' pages extracted.';
    } else {
      var zip=new JSZip();
      for(var i=0;i<sCount;i++){ var d=await PDFDocument.create(); var pp=await d.copyPages(src,[i]); d.addPage(pp[0]); zip.file('page-'+String(i+1).padStart(3,'0')+'.pdf', await d.save()); bar('sBar',Math.round((i+1)/sCount*100)); }
      var blob=await zip.generateAsync({type:'blob'}); dl(blob,'split-pages.zip'); hideBar('sBar'); $('#sStat').textContent=sCount+' pages → ZIP.';
    }
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
  var ul=$('#iList'); ul.innerHTML='';
  iFiles.forEach(function(f,i){
    var li=document.createElement('li');
    li.innerHTML='<img style="height:40px;border:1px solid #eee;border-radius:4px" src="'+URL.createObjectURL(f)+'"><span class="nm">'+(i+1)+'. '+f.name+'</span><button class="mv up">▲</button><button class="mv dn">▼</button><button class="x">✕</button>';
    li.querySelector('.up').onclick=function(){ if(i>0){var t=iFiles[i-1];iFiles[i-1]=iFiles[i];iFiles[i]=t;renderI();} };
    li.querySelector('.dn').onclick=function(){ if(i<iFiles.length-1){var t=iFiles[i+1];iFiles[i+1]=iFiles[i];iFiles[i]=t;renderI();} };
    li.querySelector('.x').onclick=function(){ iFiles.splice(i,1);renderI(); };
    ul.appendChild(li);
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
