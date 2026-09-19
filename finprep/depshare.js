/* Shared Schedule II depreciation summary — lets finprep read the depreciation
   register (saved by depreciation.js in localStorage) and fold its figures into
   the PPE note. Same origin, so localStorage is shared across the two pages. */
window.KnapDep = (function(){
  'use strict';
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
      additions:r2(additions),deletionsGross:r2(deletionsGross),depForYear:depForYear,depOnDeletion:r2(accumRemoved),
      closeGross:r2(closeGross),closeAccum:r2(closeAccum),closeWDV:r2(closeGross-closeAccum),
      disposed:disposed,profitLoss:profitLoss};
  }
  function findRegister(company, fyEnd){
    try{
      var exact=localStorage.getItem('knap-dep:'+(company||'_')+':'+fyEnd);
      if(exact) return {raw:exact, company:company};
      var hits=[];
      for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k&&k.indexOf('knap-dep:')===0&&k.slice(-(fyEnd.length))===fyEnd) hits.push(k); }
      if(company){ var lc=String(company).toLowerCase(); for(var j=0;j<hits.length;j++){ var cn=hits[j].split(':')[1]||''; if(cn.toLowerCase()===lc) return {raw:localStorage.getItem(hits[j]),company:cn}; } }
      if(hits.length===1){ return {raw:localStorage.getItem(hits[0]), company:(hits[0].split(':')[1]||'')}; }
      return null;
    }catch(e){ return null; }
  }
  function summarize(company, fyEnd){
    if(!fyEnd) return {found:false};
    var reg=findRegister(company, fyEnd); if(!reg) return {found:false};
    var d; try{ d=JSON.parse(reg.raw); }catch(e){ return {found:false}; }
    var rows=(d&&d.rows)||[]; if(!rows.length) return {found:false, company:reg.company};
    var e=new Date(fyEnd); var s=new Date(Date.UTC(e.getUTCFullYear()-1,e.getUTCMonth(),e.getUTCDate()+1));
    var fy={start:s.toISOString().slice(0,10), end:fyEnd};
    var blocks={}, dep=0, netClose=0, netOpen=0, pl=0;
    rows.forEach(function(a){ var c=computeAsset(a,fy); dep+=c.depForYear; netClose+=c.closeWDV; netOpen+=c.openNet; pl+=(c.profitLoss||0);
      var key=a.cls||'Unclassified'; var b=blocks[key]||(blocks[key]={og:0,ad:0,dl:0,cg:0,oa:0,dy:0,dd:0,ca:0});
      b.og+=c.openGross;b.ad+=c.additions;b.dl+=c.deletionsGross;b.cg+=c.closeGross;b.oa+=c.openAccum;b.dy+=c.depForYear;b.dd+=c.depOnDeletion;b.ca+=c.closeAccum; });
    return {found:true, company:reg.company, fy:fy, count:rows.length,
      depForYear:r2(dep), netClose:r2(netClose), netOpen:r2(netOpen), plOnSale:r2(pl),
      blocks:Object.keys(blocks).map(function(k){var b=blocks[k];return {cls:k,og:r2(b.og),ad:r2(b.ad),dl:r2(b.dl),cg:r2(b.cg),oa:r2(b.oa),dy:r2(b.dy),dd:r2(b.dd),ca:r2(b.ca),netClose:r2(b.cg-b.ca),netOpen:r2(b.og-b.oa)};})};
  }
  return {computeAsset:computeAsset, summarize:summarize};
})();
