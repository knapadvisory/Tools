/* PDF Editor — annotate in the browser, flatten into a new PDF with pdf-lib. */
var $=function(s){return document.querySelector(s);};
pdfjsLib.GlobalWorkerOptions.workerSrc='/pdftools/pdf.worker.min.js';
var PDFDocument=PDFLib.PDFDocument, rgb=PDFLib.rgb, StandardFonts=PDFLib.StandardFonts;

var srcBytes=null, pdfjsDoc=null, numPages=0, curPage=1, renderScale=1.4;
var annos=[];            // {id,page,type,nx,ny,nw,nh, text?,size?,color?,pts?,stroke?,img?,imgType?}
var tool='select', curColor='#111111', curSize=18, selId=null, uid=0, pending=null;

var stage=$('#stage'), pageCanvas=$('#page'), overlay=$('#overlay');
function OW(){ return parseFloat(overlay.style.width)||overlay.clientWidth; }
function OH(){ return parseFloat(overlay.style.height)||overlay.clientHeight; }
function dl(blob,name){ var u=URL.createObjectURL(blob),a=document.createElement('a'); a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){a.remove();URL.revokeObjectURL(u);},1500); }
function hex2rgb(h){ h=(h||'#000').replace('#',''); if(h.length===3)h=h.split('').map(function(c){return c+c;}).join(''); var n=parseInt(h,16); return {r:((n>>16)&255)/255,g:((n>>8)&255)/255,b:(n&255)/255}; }
function tip(t){ var el=$('#tip'); el.textContent=t||''; el.classList.toggle('hide',!t); }

/* ---------------- load ---------------- */
function setupDrop(dropSel,fileSel,onFile){
  var d=$(dropSel), f=$(fileSel);
  d.addEventListener('click',function(){f.click();});
  f.addEventListener('change',function(){ if(f.files.length) onFile(f.files[0]); f.value=''; });
  ['dragenter','dragover'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.add('hot');});});
  ['dragleave','drop'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.remove('hot');});});
  d.addEventListener('drop',function(ev){ var fs=ev.dataTransfer.files; if(fs.length) onFile(fs[0]); });
}
setupDrop('#drop','#file',loadPdf);
$('#openBtn').addEventListener('click',function(){ $('#file').click(); });
$('#file').addEventListener('change',function(){ if(this.files.length) loadPdf(this.files[0]); this.value=''; });

function loadPdf(f){
  f.arrayBuffer().then(function(a){
    srcBytes=a;
    return pdfjsLib.getDocument({data:new Uint8Array(a.slice(0))}).promise;
  }).then(function(doc){
    pdfjsDoc=doc; numPages=doc.numPages; curPage=1; annos=[]; selId=null;
    $('#pre').classList.add('hide'); $('#editor').classList.remove('hide'); $('#toolbar').classList.remove('hide');
    $('#saveBtn').disabled=false;
    buildRail(); showPage(1);
  }).catch(function(e){ alert('Could not open PDF: '+e.message); });
}

/* ---------------- page render ---------------- */
function showPage(n){
  if(n<1||n>numPages)return; curPage=n; selId=null;
  pdfjsDoc.getPage(n).then(function(page){
    var vp=page.getViewport({scale:renderScale});
    pageCanvas.width=vp.width; pageCanvas.height=vp.height;
    stage.style.width=vp.width+'px'; stage.style.height=vp.height+'px';
    overlay.style.width=vp.width+'px'; overlay.style.height=vp.height+'px';
    page.render({canvasContext:pageCanvas.getContext('2d'),viewport:vp});
    renderAnnos(); updateNav(); markRail();
  });
}
function updateNav(){ $('#pnum').textContent=curPage+' / '+numPages; $('#prev').disabled=curPage<=1; $('#next').disabled=curPage>=numPages; }
$('#prev').addEventListener('click',function(){ showPage(curPage-1); });
$('#next').addEventListener('click',function(){ showPage(curPage+1); });

function buildRail(){
  var rail=$('#rail'); rail.innerHTML='';
  for(var i=1;i<=numPages;i++){ (function(i){
    var d=document.createElement('div'); d.className='th'; d.dataset.p=i;
    d.innerHTML='<canvas></canvas><span class="n">'+i+'</span>';
    d.addEventListener('click',function(){ showPage(i); });
    rail.appendChild(d);
    pdfjsDoc.getPage(i).then(function(page){ var vp=page.getViewport({scale:0.2}); var cv=d.querySelector('canvas'); cv.width=vp.width; cv.height=vp.height; page.render({canvasContext:cv.getContext('2d'),viewport:vp}); });
  })(i); }
}
function markRail(){ document.querySelectorAll('.rail .th').forEach(function(d){ d.classList.toggle('on', +d.dataset.p===curPage); }); }

/* ---------------- tools ---------------- */
document.querySelectorAll('.tool').forEach(function(b){ b.addEventListener('click',function(){ setTool(b.dataset.tool); }); });
function setTool(t){
  tool=t;
  document.querySelectorAll('.tool').forEach(function(x){ x.classList.toggle('on', x.dataset.tool===t); });
  overlay.classList.toggle('cross', t!=='select');
  // sensible default colour per tool
  if(t==='highlight'){ curColor='#fde047'; $('#color').value='#fde047'; }
  else if(t==='whiteout'){ curColor='#ffffff'; }
  else if(t==='rect'){ if($('#color').value==='#ffffff'||$('#color').value==='#fde047'){ curColor='#e11d48'; $('#color').value='#e11d48'; } }
  else if(t==='text'||t==='draw'){ if($('#color').value==='#ffffff'||$('#color').value==='#fde047'){ curColor='#111111'; $('#color').value='#111111'; } }
  $('#sizeWrap').style.display=(t==='text'||t==='draw')?'':'none';
  if(t==='image'){ $('#imgfile').click(); }
  else if(t==='sign'){ openSig(); }
  else tip(t==='select'?'':(t==='text'?'Click on the page to add text.':(t==='draw'?'Drag to draw freehand.':(t==='image'||t==='sign'?'Click on the page to place it.':'Drag on the page to draw a '+t+'.'))));
}
$('#color').addEventListener('input',function(){ curColor=this.value; if(selId) updateSel(function(a){ if(a.type!=='image'&&a.type!=='sign'&&a.type!=='whiteout') a.color=curColor; }); });
$('#size').addEventListener('input',function(){ curSize=Math.max(6,+this.value||18); if(selId) updateSel(function(a){ if(a.type==='text'){a.size=curSize;} if(a.type==='draw'){a.stroke=curSize;} }); });
$('#undo').addEventListener('click',function(){ if(annos.length){ annos.pop(); renderAnnos(); } });
$('#clearp').addEventListener('click',function(){ annos=annos.filter(function(a){return a.page!==curPage;}); renderAnnos(); });
function updateSel(fn){ var a=annos.find(function(x){return x.id===selId;}); if(a){ fn(a); renderAnnos(); } }

/* image picked */
$('#imgfile').addEventListener('change',function(){
  var f=this.files[0]; this.value=''; if(!f)return;
  var r=new FileReader(); r.onload=function(){
    var im=new Image(); im.onload=function(){ pending={img:r.result, imgType:/png/i.test(f.type)?'png':'jpg', ar:im.height/im.width, kind:'image'}; tip('Click on the page to place the image.'); };
    im.src=r.result;
  }; r.readAsDataURL(f);
});

/* ---------------- overlay interactions ---------------- */
overlay.addEventListener('mousedown',function(e){
  if(tool==='select'){ if(e.target===overlay){ selId=null; renderAnnos(); } return; }
  if(e.target!==overlay) return; // clicked an existing anno
  var r=overlay.getBoundingClientRect(), W=r.width, H=r.height;
  var x0=(e.clientX-r.left)/W, y0=(e.clientY-r.top)/H;
  if(tool==='text'){ addText(x0,y0); return; }
  if(tool==='image'||tool==='sign'){ if(pending) placePending(x0,y0); return; }
  if(tool==='draw'){ startDraw(x0,y0,W,H); return; }
  startBox(x0,y0,W,H); // highlight / whiteout / rect
});

function startBox(x0,y0,W,H){
  var prev=document.createElement('div'); prev.className='anno '+tool;
  if(tool==='highlight'){ prev.style.background=curColor; prev.style.opacity=.35; }
  else if(tool==='whiteout'){ prev.style.background='#fff'; prev.style.border='1px solid #ddd'; }
  else { prev.style.border='2px solid '+curColor; }
  prev.style.left=(x0*W)+'px'; prev.style.top=(y0*H)+'px'; overlay.appendChild(prev);
  function mm(ev){ var x=(ev.clientX-overlay.getBoundingClientRect().left)/W, y=(ev.clientY-overlay.getBoundingClientRect().top)/H;
    var l=Math.min(x,x0),t=Math.min(y,y0),w=Math.abs(x-x0),h=Math.abs(y-y0);
    prev.style.left=(l*W)+'px'; prev.style.top=(t*H)+'px'; prev.style.width=(w*W)+'px'; prev.style.height=(h*H)+'px'; prev._box=[l,t,w,h]; }
  function mu(){ document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',mu); prev.remove();
    var b=prev._box; if(b&&b[2]>0.004&&b[3]>0.004){ var a={id:++uid,page:curPage,type:tool,nx:b[0],ny:b[1],nw:b[2],nh:b[3],color:curColor}; annos.push(a); selId=a.id; }
    renderAnnos(); if(tool!=='draw') maybeReturnSelect(); }
  document.addEventListener('mousemove',mm); document.addEventListener('mouseup',mu);
}

function startDraw(x0,y0,W,H){
  var pts=[[x0,y0]];
  var svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('width',W); svg.setAttribute('height',H);
  svg.style.position='absolute'; svg.style.left='0'; svg.style.top='0'; svg.style.pointerEvents='none';
  var pl=document.createElementNS('http://www.w3.org/2000/svg','polyline'); pl.setAttribute('fill','none'); pl.setAttribute('stroke',curColor); pl.setAttribute('stroke-width',curSize*renderScale); pl.setAttribute('stroke-linecap','round'); pl.setAttribute('stroke-linejoin','round');
  svg.appendChild(pl); overlay.appendChild(svg);
  function redraw(){ pl.setAttribute('points', pts.map(function(p){return (p[0]*W)+','+(p[1]*H);}).join(' ')); }
  redraw();
  function mm(ev){ var rb=overlay.getBoundingClientRect(); pts.push([(ev.clientX-rb.left)/W,(ev.clientY-rb.top)/H]); redraw(); }
  function mu(){ document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',mu); svg.remove();
    if(pts.length>1){ annos.push({id:++uid,page:curPage,type:'draw',pts:pts,color:curColor,stroke:curSize}); }
    renderAnnos(); }
  document.addEventListener('mousemove',mm); document.addEventListener('mouseup',mu);
}

function addText(x0,y0){
  var a={id:++uid,page:curPage,type:'text',nx:x0,ny:y0,nw:0,nh:0,text:'',size:curSize,color:curColor};
  annos.push(a); selId=a.id; renderAnnos();
  var el=overlay.querySelector('[data-id="'+a.id+'"] .ed'); if(el){ el.focus(); }
  maybeReturnSelect();
}
function placePending(x0,y0){
  if(!pending)return;
  var W=OW(),H=OH(); var wpx=Math.min(W*0.3, 260); var hpx=wpx*pending.ar;
  var a={id:++uid,page:curPage,type:pending.kind,nx:x0,ny:y0,nw:wpx/W,nh:hpx/H,img:pending.img,imgType:pending.imgType};
  annos.push(a); selId=a.id; pending=null; tip(''); renderAnnos(); setTool('select');
}
function maybeReturnSelect(){ /* stay on tool for repeated use; user can switch to Select to move */ }

/* ---------------- annotation elements ---------------- */
function renderAnnos(){
  overlay.innerHTML=''; var W=OW(),H=OH();
  annos.filter(function(a){return a.page===curPage;}).forEach(function(a){
    var el = a.type==='text'? textEl(a,W,H) : a.type==='draw'? drawAnnoEl(a,W,H) : boxAnnoEl(a,W,H);
    if(a.id===selId) el.classList.add('sel');
    overlay.appendChild(el);
  });
}
function posBox(el,a,W,H){ el.style.left=(a.nx*W)+'px'; el.style.top=(a.ny*H)+'px'; el.style.width=(a.nw*W)+'px'; el.style.height=(a.nh*H)+'px'; }
function delBtn(a){ var x=document.createElement('div'); x.className='del'; x.textContent='✕'; x.addEventListener('mousedown',function(ev){ev.stopPropagation();}); x.addEventListener('click',function(ev){ ev.stopPropagation(); removeAnno(a.id); }); return x; }
function removeAnno(id){ annos=annos.filter(function(a){return a.id!==id;}); if(selId===id)selId=null; renderAnnos(); }

function boxAnnoEl(a,W,H){
  var el=document.createElement('div'); el.className='anno '+a.type; el.dataset.id=a.id; posBox(el,a,W,H);
  if(a.type==='highlight'){ el.style.background=a.color; el.style.opacity=.35; }
  else if(a.type==='whiteout'){ el.style.background='#fff'; el.style.border='1px solid #eee'; }
  else if(a.type==='rect'){ el.style.border='2px solid '+a.color; }
  else if(a.type==='image'||a.type==='sign'){ var im=document.createElement('img'); im.src=a.img; im.draggable=false; el.appendChild(im); }
  var rz=document.createElement('div'); rz.className='rz'; el.appendChild(rz); el.appendChild(delBtn(a));
  el.addEventListener('mousedown',function(ev){ if(ev.target===rz)return; if(tool!=='select')return; select(a.id); startMove(a,ev,W,H); });
  rz.addEventListener('mousedown',function(ev){ ev.stopPropagation(); select(a.id); startResize(a,ev,W,H,true); });
  return el;
}
function textEl(a,W,H){
  var el=document.createElement('div'); el.className='anno text'; el.dataset.id=a.id;
  el.style.left=(a.nx*W)+'px'; el.style.top=(a.ny*H)+'px';
  var grip=document.createElement('div'); grip.className='grip'; grip.textContent='⣿'; el.appendChild(grip);
  var ed=document.createElement('div'); ed.className='ed'; ed.contentEditable='true'; ed.textContent=a.text||'';
  ed.style.color=a.color; ed.style.fontSize=(a.size*renderScale)+'px'; ed.style.lineHeight=1.15;
  el.appendChild(ed); el.appendChild(delBtn(a));
  ed.addEventListener('input',function(){ a.text=ed.innerText; a.nw=el.offsetWidth/W; a.nh=el.offsetHeight/H; });
  ed.addEventListener('blur',function(){ a.text=ed.innerText; a.nw=el.offsetWidth/W; a.nh=el.offsetHeight/H; if(!a.text.trim()) removeAnno(a.id); });
  ed.addEventListener('mousedown',function(ev){ ev.stopPropagation(); select(a.id); });
  grip.addEventListener('mousedown',function(ev){ ev.stopPropagation(); select(a.id); startMove(a,ev,W,H); });
  // capture natural size after insert
  setTimeout(function(){ a.nw=el.offsetWidth/W; a.nh=el.offsetHeight/H; },0);
  return el;
}
function drawAnnoEl(a,W,H){
  var el=document.createElement('div'); el.className='anno draw'; el.dataset.id=a.id;
  el.style.left='0'; el.style.top='0'; el.style.width=W+'px'; el.style.height=H+'px'; el.style.pointerEvents='none';
  var ns='http://www.w3.org/2000/svg';
  var svg=document.createElementNS(ns,'svg'); svg.setAttribute('width',W); svg.setAttribute('height',H); svg.style.position='absolute'; svg.style.left='0'; svg.style.top='0';
  var pl=document.createElementNS(ns,'polyline'); pl.setAttribute('fill','none'); pl.setAttribute('stroke',a.color); pl.setAttribute('stroke-width',(a.stroke||2)*renderScale); pl.setAttribute('stroke-linecap','round'); pl.setAttribute('stroke-linejoin','round');
  pl.setAttribute('points', a.pts.map(function(p){return (p[0]*W)+','+(p[1]*H);}).join(' ')); svg.appendChild(pl); el.appendChild(svg);
  var x=delBtn(a); x.style.display='block'; x.style.pointerEvents='auto'; x.style.left=(a.pts[0][0]*W-4)+'px'; x.style.top=(a.pts[0][1]*H-20)+'px'; x.style.right='auto'; el.appendChild(x);
  return el;
}
function select(id){ selId=id; document.querySelectorAll('.anno').forEach(function(el){ el.classList.toggle('sel', +el.dataset.id===id); });
  var a=annos.find(function(x){return x.id===id;}); if(a){ if(a.color){ $('#color').value=/^#/.test(a.color)?a.color:'#111111'; curColor=$('#color').value; } if(a.type==='text'){ $('#size').value=a.size; } if(a.type==='draw'){ $('#size').value=a.stroke; } } }

function startMove(a,ev,W,H){
  ev.preventDefault(); var sx=ev.clientX, sy=ev.clientY, ox=a.nx, oy=a.ny;
  function mm(e){ a.nx=Math.max(0,ox+(e.clientX-sx)/W); a.ny=Math.max(0,oy+(e.clientY-sy)/H);
    var el=overlay.querySelector('[data-id="'+a.id+'"]'); if(el){ el.style.left=(a.nx*W)+'px'; el.style.top=(a.ny*H)+'px'; } }
  function mu(){ document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',mu); }
  document.addEventListener('mousemove',mm); document.addEventListener('mouseup',mu);
}
function startResize(a,ev,W,H,keepAspect){
  ev.preventDefault(); var sx=ev.clientX, sy=ev.clientY, ow=a.nw, oh=a.nh, ar=oh/ow;
  function mm(e){ var nw=Math.max(0.01, ow+(e.clientX-sx)/W); var nh=Math.max(0.01, oh+(e.clientY-sy)/H);
    if(keepAspect && (a.type==='image'||a.type==='sign')){ nh=nw*ar; }
    a.nw=nw; a.nh=nh; var el=overlay.querySelector('[data-id="'+a.id+'"]'); if(el){ el.style.width=(nw*W)+'px'; el.style.height=(nh*H)+'px'; } }
  function mu(){ document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',mu); }
  document.addEventListener('mousemove',mm); document.addEventListener('mouseup',mu);
}
document.addEventListener('keydown',function(e){ if((e.key==='Delete'||e.key==='Backspace') && selId!=null){ var ae=document.activeElement; if(ae&&ae.classList&&ae.classList.contains('ed'))return; e.preventDefault(); removeAnno(selId); } });

/* ---------------- signature pad ---------------- */
var sigCtx, sigDrawing=false, sigDirty=false;
function openSig(){ var m=$('#sigModal'); m.classList.add('show'); var c=$('#sigpad'); var r=c.getBoundingClientRect(); c.width=r.width; c.height=r.height; sigCtx=c.getContext('2d'); sigCtx.lineWidth=2.4; sigCtx.lineCap='round'; sigCtx.strokeStyle='#0b3b8c'; sigDirty=false; }
function sigPos(e){ var c=$('#sigpad'), r=c.getBoundingClientRect(); var t=e.touches?e.touches[0]:e; return [t.clientX-r.left, t.clientY-r.top]; }
(function(){ var c=$('#sigpad');
  function down(e){ sigDrawing=true; sigDirty=true; var p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p[0],p[1]); e.preventDefault(); }
  function move(e){ if(!sigDrawing)return; var p=sigPos(e); sigCtx.lineTo(p[0],p[1]); sigCtx.stroke(); e.preventDefault(); }
  function up(){ sigDrawing=false; }
  ['mousedown','touchstart'].forEach(function(ev){ c.addEventListener(ev,down); });
  ['mousemove','touchmove'].forEach(function(ev){ c.addEventListener(ev,move); });
  ['mouseup','touchend','mouseleave'].forEach(function(ev){ c.addEventListener(ev,up); });
})();
$('#sigclear').addEventListener('click',function(){ sigCtx.clearRect(0,0,$('#sigpad').width,$('#sigpad').height); sigDirty=false; });
$('#sigcancel').addEventListener('click',function(){ $('#sigModal').classList.remove('show'); setTool('select'); });
$('#siguse').addEventListener('click',function(){
  if(!sigDirty){ $('#sigModal').classList.remove('show'); setTool('select'); return; }
  var url=$('#sigpad').toDataURL('image/png'); var im=new Image();
  im.onload=function(){ pending={img:url,imgType:'png',ar:im.height/im.width,kind:'sign'}; $('#sigModal').classList.remove('show'); tip('Click on the page to place your signature.'); };
  im.src=url;
});

/* ---------------- save (flatten) ---------------- */
$('#saveBtn').addEventListener('click',function(){
  $('#saveBtn').disabled=true; $('#saveBtn').textContent='Saving…';
  (async function(){
    var doc=await PDFDocument.load(srcBytes,{ignoreEncryption:true});
    var font=await doc.embedFont(StandardFonts.Helvetica);
    var pages=doc.getPages();
    for(var i=0;i<annos.length;i++){
      var a=annos[i], pg=pages[a.page-1]; if(!pg)continue;
      var PW=pg.getWidth(), PH=pg.getHeight();
      if(a.type==='text'){
        if(!a.text||!a.text.trim())continue; var c=hex2rgb(a.color); var sz=a.size;
        var lines=String(a.text).split('\n');
        for(var li=0; li<lines.length; li++){
          pg.drawText(lines[li], {x:a.nx*PW, y:PH - a.ny*PH - sz - li*sz*1.15, size:sz, font:font, color:rgb(c.r,c.g,c.b) });
        }
      } else if(a.type==='highlight'||a.type==='rect'||a.type==='whiteout'){
        var c2=hex2rgb(a.type==='whiteout'?'#ffffff':a.color);
        pg.drawRectangle({ x:a.nx*PW, y:PH-(a.ny+a.nh)*PH, width:a.nw*PW, height:a.nh*PH,
          color: a.type==='rect'? undefined : rgb(c2.r,c2.g,c2.b),
          opacity: a.type==='highlight'?0.35:1,
          borderColor: a.type==='rect'? rgb(c2.r,c2.g,c2.b): undefined,
          borderWidth: a.type==='rect'? 1.4 : 0 });
      } else if(a.type==='image'||a.type==='sign'){
        var bytes=await (await fetch(a.img)).arrayBuffer();
        var img = a.imgType==='png'? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        pg.drawImage(img,{ x:a.nx*PW, y:PH-(a.ny+a.nh)*PH, width:a.nw*PW, height:a.nh*PH });
      } else if(a.type==='draw'){
        var c3=hex2rgb(a.color); var pw=(a.stroke||2); var cap=PDFLib.LineCapStyle?PDFLib.LineCapStyle.Round:undefined;
        for(var k=1;k<a.pts.length;k++){ var p0=a.pts[k-1], p1=a.pts[k];
          var seg={ start:{x:p0[0]*PW, y:PH-p0[1]*PH}, end:{x:p1[0]*PW, y:PH-p1[1]*PH}, thickness:pw, color:rgb(c3.r,c3.g,c3.b) }; if(cap!==undefined) seg.lineCap=cap;
          pg.drawLine(seg); }
      }
    }
    var out=await doc.save();
    dl(new Blob([out],{type:'application/pdf'}),'edited.pdf');
  })().catch(function(e){ alert('Save failed: '+e.message); }).then(function(){ $('#saveBtn').disabled=false; $('#saveBtn').textContent='⬇ Save PDF'; });
});
