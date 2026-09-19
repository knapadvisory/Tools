/* ============================================================================
 * KNAP finprep — in-tool Assistant
 * Give the tool instructions, teach it grouping rules, ask how-to questions, and
 * leave feedback. Works fully OFFLINE (no data leaves the machine); can OPTIONALLY
 * use the Anthropic API for free-form answers if the user pastes their own key.
 *
 * It drives the real tool state defined in index.html's inline script (globals):
 *   TB, overrides, subMap, framework, UNIT, prepared, NOTES, __learnRules,
 *   prepare(), classify(), grpNorm(), depCompanyName(), knapRefreshAll(), sigEl()
 * ==========================================================================*/
(function(){
  'use strict';
  if(window.__knapAssistant) return; window.__knapAssistant=true;

  /* ---------- small helpers ---------- */
  function $(id){ return document.getElementById(id); }
  function el(tag,cls,html){ var e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function norm(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z0-9%&\s]/g,' ').replace(/\s+/g,' ').trim(); }
  function nowISO(){ return new Date().toISOString(); }
  function lsGet(k,d){ try{ var v=localStorage.getItem(k); return v==null?d:v; }catch(e){ return d; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function lsJSON(k,d){ try{ var v=JSON.parse(localStorage.getItem(k)); return v==null?d:v; }catch(e){ return d; } }

  /* ---------- config (persisted) ---------- */
  var CFG=lsJSON('knap-as-cfg',{apiEnabled:false,apiKey:'',model:'claude-haiku-4-5-20251001',mode:'offline'});
  function saveCfg(){ lsSet('knap-as-cfg',JSON.stringify(CFG)); }

  /* ---------- note / head vocabulary ---------- */
  // phrase -> Schedule III note number (mirrors NOTES in index.html)
  var HEADS=[
    ['share capital',1],['equity share',1],['capital account',1],
    ['reserves',2],['reserve and surplus',2],['reserves and surplus',2],['surplus',2],['retained earning',2],['securities premium',2],['profit and loss balance',2],
    ['long term borrowing',4],['long-term borrowing',4],['term loan',4],['secured loan',4],['unsecured loan',4],['debenture',4],
    ['deferred tax liab',5],['dtl',5],
    ['other long term liab',6],['other long-term liab',6],
    ['long term provision',7],['long-term provision',7],
    ['short term borrowing',8],['short-term borrowing',8],['bank od',8],['bank o d',8],['overdraft',8],['cash credit',8],['occ',8],['working capital loan',8],
    ['trade payable',9],['payable',9],['sundry creditor',9],['creditor',9],
    ['other current liab',10],['duties and taxes',10],['gst payable',10],['statutory due',10],
    ['short term provision',11],['short-term provision',11],['provision for tax',11],['provision',11],
    ['property plant',12],['plant and machinery',12],['plant machinery',12],['fixed asset',12],['ppe',12],['tangible asset',12],['intangible asset',12],['furniture',12],['vehicle',12],['computer',12],['building',12],
    ['non current investment',13],['non-current investment',13],['long term investment',13],
    ['deferred tax asset',14],['dta',14],
    ['long term loan and advance',15],['long-term loan',15],['security deposit',15],['deposit',15],
    ['other non current asset',16],['other non-current asset',16],['preliminary expense',16],
    ['current investment',17],['mutual fund',17],['liquid fund',17],
    ['inventory',18],['inventories',18],['stock',18],['closing stock',18],['raw material',18],['finished good',18],['work in progress',18],['stores and spare',18],
    ['trade receivable',19],['receivable',19],['sundry debtor',19],['debtor',19],
    ['cash and cash equivalent',20],['cash and bank',20],['cash',20],['bank balance',20],['bank account',20],['petty cash',20],
    ['short term loan and advance',21],['short-term loan',21],['advance',21],['prepaid',21],['tds receivable',21],['advance tax',21],
    ['other current asset',22],['input gst',22],['input tax',22],['gst receivable',22],['itc',22],
    ['revenue from operation',23],['revenue',23],['sales',23],['turnover',23],['operating income',23],
    ['other income',24],['interest income',24],['interest received',24],['discount received',24],['rental income',24],['dividend',24],
    ['cost of material consumed',25],['cost of material',25],['material consumed',25],['purchase',25],['cost of goods',25],
    ['changes in inventory',26],['change in inventory',26],['changes in inventories',26],
    ['employee benefit',27],['salary',27],['salaries',27],['wages',27],['staff',27],['bonus',27],['gratuity',27],['provident fund',27],['esi',27],['remuneration',27],['payroll',27],
    ['finance cost',28],['interest expense',28],['interest paid',28],['bank charge',28],['interest on loan',28],
    ['other expense',29],['administrative expense',29],['office expense',29],['misc expense',29],['expenses',29],['expense',29]
  ];
  function noteFromText(t){
    var s=norm(t); if(!s) return null;
    var best=null,bestLen=0;
    for(var i=0;i<HEADS.length;i++){ var kw=HEADS[i][0]; if(s.indexOf(kw)>=0 && kw.length>bestLen){ best=HEADS[i][1]; bestLen=kw.length; } }
    if(best!=null) return best;
    // bare note number like "note 27" or "27"
    var m=s.match(/(?:note\s*)?(\d{1,2})\b/); if(m){ var n=+m[1]; if(window.NOTES && NOTES[n]) return n; }
    return null;
  }
  function headName(n){ return (window.NOTES && NOTES[n]) ? NOTES[n].head : ('Note '+n); }

  /* ---------- resolve a ledger phrase to a real TB ledger name ---------- */
  function findLedger(t){
    if(!window.TB || !TB.ledgers || !TB.ledgers.length) return null;
    var s=norm(t); if(!s) return null;
    var names=TB.ledgers.map(function(l){return l.name;});
    // exact (normalized)
    for(var i=0;i<names.length;i++){ if(norm(names[i])===s) return names[i]; }
    // contains either way
    var cand=names.filter(function(nm){ var nn=norm(nm); return nn.indexOf(s)>=0 || s.indexOf(nn)>=0; });
    if(cand.length===1) return cand[0];
    if(cand.length>1){ cand.sort(function(a,b){return Math.abs(norm(a).length-s.length)-Math.abs(norm(b).length-s.length);}); return cand[0]; }
    // token overlap
    var toks=s.split(' ').filter(function(x){return x.length>2;});
    var scored=names.map(function(nm){ var nn=norm(nm); var sc=0; toks.forEach(function(tk){ if(nn.indexOf(tk)>=0)sc++; }); return {nm:nm,sc:sc}; })
                    .filter(function(x){return x.sc>0;}).sort(function(a,b){return b.sc-a.sc;});
    return scored.length?scored[0].nm:null;
  }

  /* ---------- persist a ledger->note into the grouping memory (for next time) ---------- */
  function grpPersist(ledgerName,note,sub){
    try{
      var co=(window.depCompanyName?depCompanyName():'')||'';
      var key='knap-grp:'+(window.grpNorm?grpNorm(co):co.toLowerCase());
      var obj=lsJSON(key,null); if(!obj||typeof obj!=='object') obj={company:co,map:{}}; if(!obj.map)obj.map={};
      var nk=(window.grpNorm?grpNorm(ledgerName):String(ledgerName).toLowerCase());
      var prev=obj.map[nk]||{}; obj.map[nk]={note:Number(note),sub:(sub!=null?sub:prev.sub)};
      lsSet(key,JSON.stringify(obj));
    }catch(e){}
  }

  /* ---------- executor: applies a structured action to the tool ---------- */
  var UNIT_MAP={full:1,hundreds:100,thousands:1000,lakh:100000,lakhs:100000,crore:10000000,crores:10000000};
  var UNIT_LABEL={1:'₹ in full',100:'₹ in hundreds',1000:'₹ in ’000',100000:'₹ in lakh',10000000:'₹ in crore'};
  function executeAction(a){
    if(!a||!a.type) return null;
    try{
      if(a.type==='framework'){
        var v=(String(a.value||'').toUpperCase().indexOf('IND')>=0||/2|ii/.test(String(a.value)))?'INDAS':'AS';
        window.framework=v; var fe=$('chipFw'); if(fe){fe.value=v;} lsSet('knap-fw',v);
        try{ if(window.prepared){ renderBS(); renderPL(); } }catch(e){}
        return 'Reporting framework set to '+(v==='INDAS'?'Ind AS · Division II':'AS · Division I')+'.';
      }
      if(a.type==='unit'){
        var div=UNIT_MAP[String(a.value||'').toLowerCase()]||Number(a.value)||1;
        if(!UNIT_LABEL[div]) div=1;
        window.UNIT.div=div; window.UNIT.label=UNIT_LABEL[div];
        var ue=$('chipUnit'); if(ue){ ue.value=String(div); }
        try{ if(window.TB){ renderReviewStep2(); } if(window.prepared){ renderBS(); renderPL(); renderNotes(); } }catch(e){}
        return 'Figures now shown in '+UNIT_LABEL[div]+' (the Excel export stays in full rupees).';
      }
      if(a.type==='group'){
        var note=Number(a.note); if(!(window.NOTES&&NOTES[note])) return 'I could not tell which Schedule III head that is.';
        var led=a.ledger; var exact=findLedger(led);
        if(exact){ window.overrides[exact]=note; grpPersist(exact,note); knapRefreshAll();
          return '“'+exact+'” is now grouped under '+headName(note)+' (Note '+note+') — remembered for next time too.'; }
        // no matching ledger yet → make it a learned keyword rule
        var kw=norm(led); if(kw.length<2) return 'I could not find a ledger like that.';
        addLearn(kw,note);
        return 'No ledger named “'+esc(led)+'” is loaded, so I saved a rule: any ledger containing “'+kw+'” → '+headName(note)+' (Note '+note+'). It will apply now and to future companies.';
      }
      if(a.type==='learn'){
        var n2=Number(a.note); if(!(window.NOTES&&NOTES[n2])) return 'I could not tell which head to learn.';
        var kw2=norm(a.kw); if(kw2.length<2) return 'Give me a keyword of 2+ characters to learn.';
        addLearn(kw2,n2);
        return 'Learned: any ledger containing “'+kw2+'” → '+headName(n2)+' (Note '+n2+'). Saved for this and future companies.';
      }
      if(a.type==='field'){
        var f=String(a.name||'').toLowerCase(); var val=a.value==null?'':String(a.value);
        var map={entity:'entity','company name':'entity','legal name':'sig_legalname',legalname:'sig_legalname',cin:'sig_cin','auditor firm':'sig_firm','firm name':'sig_firm',firm:'sig_firm',frn:'sig_frn',partner:'sig_partner',mno:'sig_mno',mrn:'sig_mno',membership:'sig_mno',place:'sig_place',date:'sig_date'};
        var id=map[f]; if(!id) return 'I can set: company name, legal name, CIN, auditor firm, FRN, partner, membership no, place, date.';
        var e=$(id); if(!e) return 'That field is not on this page.';
        e.value=val; try{ e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){}
        return 'Set '+f+' to “'+esc(val)+'”.';
      }
      if(a.type==='refresh'){ knapRefreshAll(); return 'Re-prepared the statements.'; }
    }catch(e){ return 'Could not apply that ('+e.message+').'; }
    return null;
  }
  function addLearn(kw,note){
    if(!window.__learnRules) window.__learnRules=[];
    // replace an existing rule with the same keyword
    window.__learnRules=window.__learnRules.filter(function(r){return norm(r.kw)!==norm(kw);});
    window.__learnRules.push({kw:kw,note:Number(note),ts:nowISO()});
    lsSet('knap-learn',JSON.stringify(window.__learnRules));
    knapRefreshAll();
  }

  /* ---------- offline intent parser: text -> {action} or null ---------- */
  function parseAction(text){
    var s=norm(text);
    if(!s) return null;
    // an informational question ("how/what/why…") should be answered, not executed
    if(/^(how|what|why|when|which|whom|explain|tell me|describe|do you|does|is there|are there)\b/.test(s)) return null;
    // refresh
    if(/^(re[-\s]?prepare|refresh|recompute|rebuild|redo)\b/.test(s) || /\bre[-\s]?prepare\b/.test(s)) return {type:'refresh'};
    // framework
    if(/\bind\s*as\b|\bindas\b|division\s*(ii|2)\b/.test(s)) return {type:'framework',value:'INDAS'};
    if(!/ind/.test(s) && (/division\s*(i|1)\b/.test(s) || /indian gaap/.test(s) || (/\bas\b/.test(s) && /(switch|use|change|set|report|framework|convert|move|prepare under)/.test(s)))) return {type:'framework',value:'AS'};
    // units
    if(/\bcrore/.test(s)) return {type:'unit',value:'crore'};
    if(/\blakh/.test(s)) return {type:'unit',value:'lakh'};
    if(/\b(thousand|000s|’000|in 000)\b/.test(s)) return {type:'unit',value:'thousands'};
    if(/\bhundred/.test(s)) return {type:'unit',value:'hundreds'};
    if(/\b(full rupee|in full|actual (figure|amount)|rupees full|no scaling)\b/.test(s)) return {type:'unit',value:'full'};
    // set a field
    var mf=text.match(/set\s+(?:the\s+)?(company name|legal name|entity|cin|auditor firm|firm name|frn|partner|membership(?:\s*no)?|mrn|place|date)\s+(?:to|as|=|:)\s+(.+)/i);
    if(mf){ var fld=mf[1].toLowerCase().replace('membership no','membership').replace('membership','membership'); return {type:'field',name:fld,value:mf[2].trim()}; }
    // teach a keyword rule
    var mt=text.match(/(?:always|any\s+ledger(?:s)?|whenever|remember|treat)\b(?:\s+(?:that|the|a|an|is|are|ledgers?|with|containing|named|called|has|have|contains?|treat))*\s+["“']?(.+?)["”']?\s+(?:as|is|are|under|to|=|:)\s+(.+)/i);
    if(mt){ var note1=noteFromText(mt[2]); var kw=norm(mt[1]); if(note1!=null && kw.length>=2 && /always|any|whenever|remember|treat/i.test(text)) return {type:'learn',kw:kw,note:note1}; }
    // group a specific ledger
    var mg=text.match(/(?:group|map|classify|put|move|reclassif\w*|assign|show)\s+(.+?)\s+(?:under|to|as|in|into)\s+(.+)/i);
    if(mg){ var note2=noteFromText(mg[2]); if(note2!=null) return {type:'group',ledger:mg[1].trim(),note:note2}; }
    // "<ledger> is <head>" / "<ledger> goes to <head>"
    var mg2=text.match(/^(.+?)\s+(?:is|are|should be|belongs?\s+(?:to|under)|goes?\s+(?:to|under)|comes?\s+under)\s+(.+)$/i);
    if(mg2 && !/\?$/.test(text.trim())){ var note3=noteFromText(mg2[2]); if(note3!=null){ var lp=mg2[1].trim(); if(findLedger(lp)) return {type:'group',ledger:lp,note:note3}; } }
    return null;
  }

  /* ---------- help knowledge base ---------- */
  var FAQ=[
    {k:['import','previous','prior','last year','comparative','fetch','opening'],a:'To pull last year’s comparatives: use the “Import from last year’s financials” button (in the signatories panel and on the depreciation page). It reads shareholders, signatory details, previous-year figures, and opening WDV (Schedule II and Income-tax). The tool takes the figures from the note-detail sheets when the Balance-Sheet/P&L faces are blank, so P&L comparatives come through even in firm templates. Current-year figures always come from Tally; only the previous-year column is set from the uploaded file.'},
    {k:['negative','minus','sign','why is','bracket'],a:'Nothing on the face should print negative now. Equity, liabilities and income are shown in their natural (positive) sign; assets and expenses stay Dr-positive. On export, the Trial Balance sheet carries a Dr/Cr column and each figure in its natural sign, and the Notes/Balance-Sheet/P&L link to it — so no head exports as a negative.'},
    {k:['roll','forward','next year','carry'],a:'“Roll forward” (depreciation page) carries this year’s closing WDV as next year’s opening and shifts the financial year, so you re-import the working paper and continue without re-keying opening balances.'},
    {k:['unit','lakh','crore','thousand','scale','figure in'],a:'Use the unit selector at the top, or just tell me “show figures in lakhs / crores / thousands”. It only rescales the on-screen preview — the Excel export is always in full rupees.'},
    {k:['ind as','indas','division','as','framework','gaap'],a:'The framework selector switches Schedule III presentation between AS (Division I) and Ind AS (Division II). Say “switch to Ind AS” or “use AS”. It changes the Balance Sheet/P&L layout (e.g. Ind AS adds OCI / Total comprehensive income).'},
    {k:['depreciation','schedule ii','wdv','useful life','asset'],a:'Open the Depreciation (Schedule II) page from the workpapers row. Maintain the fixed-asset register; depreciation is charged pro-rata by days from date-in-use, capped at residual value. Its net block and charge fold back into Note 12 and the P&L here.'},
    {k:['income tax','section 32','block','it depreciation'],a:'The depreciation page also computes Income-tax depreciation (Section 32, block-of-assets WDV, half-rate under 180 days). Enter each block’s opening WDV as per the last return (or import it from last year’s working paper).'},
    {k:['deferred tax','dta','dtl','as 22','timing'],a:'The depreciation page computes deferred tax (AS 22) from the book-vs-tax WDV difference at your effective rate, plus any other timing differences you add. It gives the opening→closing→charge for the year.'},
    {k:['returned','reverse','exclude','not part'],a:'On the depreciation register, tick the “Excl.” checkbox on any asset that was purchased but returned/reversed. It is then dropped from the gross block, Schedule II depreciation and the income-tax block — no depreciation is charged and it never reaches the PPE note.'},
    {k:['group','review','sub-group','classify','head','note assign'],a:'Step 2 (Review grouping) lets you check and change every ledger’s Schedule III head and sub-group before finalising. You can also just tell me e.g. “group Salary under Employee benefits” or teach a rule “always treat ‘courier’ as Other expenses”, and I’ll apply and remember it.'},
    {k:['export','excel','notes','linked','trial balance','workpaper'],a:'Export produces one workbook: Balance Sheet, P&L, Notes, Cash Flow, Trial Balance (with Dr/Cr and remarks) and Review. The Balance-Sheet/P&L faces are live-linked to the Notes, and the Notes to the Trial Balance, so every figure is traceable to a ledger.'},
    {k:['shareholder','signatory','director','din','cin','frn','partner','auditor'],a:'Fill the signatories & shareholders panel (company legal name, CIN, auditor firm + FRN, partner + membership no, directors + DIN, shareholders >5%). These flow into the export’s signature block and Note 1. You can auto-fill them by importing last year’s financials.'},
    {k:['connector','tally','pull','read','trial balance from'],a:'Run the tool on the PC where Tally is open. Set the period and click Read to pull the trial balance via the connector; it classifies every ledger into Schedule III heads automatically, then you review in Step 2.'},
    {k:['ratio','analysis','annexure'],a:'The export includes a Ratio Analysis sheet (Schedule III Annexure format: current, debt-equity, DSCR, returns, turnover ratios, etc.) with current vs previous year.'},
    {k:['assistant','what can you','help','commands','do you do'],a:'I can (1) change the tool — “switch to Ind AS”, “show figures in lakhs”, “group <ledger> under <head>”, “set CIN to …”; (2) teach persistent rules — “always treat ‘freight’ as Other expenses”; (3) answer how-to questions about the tool; and (4) log your feedback/improvement ideas (⚙ → Feedback) so they reach the developer. I work offline; you can also enable the AI (⚙) for free-form answers.'}
  ];
  function helpAnswer(text){
    var s=norm(text); var toks=s.split(' ').filter(function(x){return x.length>2;});
    var best=null,bestSc=0;
    FAQ.forEach(function(f){ var sc=0; f.k.forEach(function(kw){ if(s.indexOf(kw)>=0) sc+=2; toks.forEach(function(t){ if(kw.indexOf(t)>=0)sc+=0.5; }); }); if(sc>bestSc){bestSc=sc;best=f;} });
    return bestSc>=2?best.a:null;
  }

  /* ---------- feedback log ---------- */
  function logFeedback(kind,text){
    var log=lsJSON('knap-feedback',[]); if(!Array.isArray(log))log=[];
    log.push({kind:kind,text:text,company:(window.depCompanyName?depCompanyName():'')||'',framework:window.framework||'',ts:nowISO()});
    lsSet('knap-feedback',JSON.stringify(log)); return log.length;
  }
  function isQuestion(text){ var s=norm(text); return /\?$/.test(text.trim())||/^(how|what|why|when|where|which|can|does|do|is|are|should|could|would|explain|tell me|help)\b/.test(s); }
  function looksLikeFeedback(text){ var s=norm(text); return /^(feedback|suggestion|suggest|idea|bug|issue|improve|improvement|feature|please add|can you add|it should|would be nice|there should|add a|add an|missing)\b/.test(s) || /should be able to|it would be better|not working|doesn t work|does not work/.test(s); }

  /* ---------- main dispatcher ---------- */
  function respond(text,cb){
    var t=text.trim(); if(!t){ cb(''); return; }
    // explicit feedback always wins
    if(looksLikeFeedback(t)){ var n=logFeedback('feedback',t); cb('📝 Logged your feedback (#'+n+'). It’s saved locally — open ⚙ → Feedback to review or export the list for the developer. The tool can’t rewrite its own code, so this is how improvement requests are collected.'); return; }
    // try to act
    var act=parseAction(t);
    if(act){ var r=executeAction(act); if(r){ cb('✅ '+r); return; } }
    // help
    var h=helpAnswer(t);
    var mode=CFG.mode||'offline';
    if(h && !(CFG.apiEnabled && mode==='ai')){ cb(h); return; }
    // AI (optional)
    if(CFG.apiEnabled && CFG.apiKey){ askClaude(t,cb, h); return; }
    // no AI: give help if any, else guide + log an unanswered question
    if(h){ cb(h); return; }
    if(isQuestion(t)){ logFeedback('question',t); cb('I don’t have a built-in answer for that. I’ve noted the question — you can enable the AI assistant (⚙) for free-form answers, or ask me about: importing last year’s figures, grouping, Ind AS vs AS, units, depreciation, deferred tax, or export.'); return; }
    // otherwise treat as feedback
    var n2=logFeedback('feedback',t); cb('📝 I couldn’t map that to an action, so I logged it as feedback (#'+n2+'). Try e.g. “group <ledger> under Other expenses”, “switch to Ind AS”, or “show figures in lakhs”.');
  }

  /* ---------- optional Anthropic API ---------- */
  function toolContext(){
    var lines=[];
    lines.push('Company: '+((window.depCompanyName?depCompanyName():'')||'(not set)'));
    lines.push('Framework: '+(window.framework==='INDAS'?'Ind AS (Division II)':'AS (Division I)'));
    lines.push('Display unit: '+((window.UNIT&&UNIT.label)||'₹ in full'));
    lines.push('Trial balance loaded: '+(window.TB&&TB.ledgers?('yes, '+TB.ledgers.length+' ledgers'):'no'));
    if(window.NOTES){ var hs=Object.keys(NOTES).filter(function(k){return k!=='99';}).map(function(k){return k+'='+NOTES[k].head;}); lines.push('Schedule III notes: '+hs.join('; ')); }
    if(window.TB&&TB.ledgers){ lines.push('Ledger names (no amounts): '+TB.ledgers.slice(0,120).map(function(l){return l.name;}).join(' | ')); }
    return lines.join('\n');
  }
  function sysPrompt(){
    return [
'You are the built-in assistant for KNAP finprep, a tool that turns a Tally trial balance into Schedule III (Companies Act 2013) financial statements for an Indian CA firm.',
'Answer briefly and practically. You may CHANGE the tool by emitting one or more fenced action blocks; the app executes them and shows the result. Put a short sentence before each block.',
'Action block format (JSON), fenced as ```knap-action ... ```:',
'  {"type":"framework","value":"INDAS"}            // or "AS"',
'  {"type":"unit","value":"lakhs"}                  // full|hundreds|thousands|lakhs|crores',
'  {"type":"group","ledger":"<exact ledger name from the list>","note":<1-29>}',
'  {"type":"learn","kw":"<keyword>","note":<1-29>}  // persistent rule for any ledger containing keyword',
'  {"type":"field","name":"cin","value":"..."}      // entity|legalname|cin|firm|frn|partner|mno|place|date',
'  {"type":"refresh"}',
'Only use ledger names exactly as given. Use the note numbers from the notes list. If the user only asks a how-to question, answer without an action block.',
'Never invent figures; you are not given amounts. Current-year figures come from Tally; the prior-year column can be imported from last year’s financials.',
'CURRENT TOOL STATE:',
toolContext()
    ].join('\n');
  }
  var HIST=[];
  function askClaude(text,cb,fallbackHelp){
    HIST.push({role:'user',content:text});
    var body={model:CFG.model||'claude-haiku-4-5-20251001',max_tokens:800,system:sysPrompt(),messages:HIST.slice(-10)};
    fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':CFG.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify(body)})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
    .then(function(res){
      if(!res.ok){ var em=(res.j&&res.j.error&&res.j.error.message)||('HTTP error'); cb('⚠️ AI error: '+esc(em)+(fallbackHelp?('\n\nMeanwhile: '+fallbackHelp):'')); return; }
      var txt=''; try{ txt=res.j.content.map(function(c){return c.text||'';}).join('').trim(); }catch(e){}
      HIST.push({role:'assistant',content:txt});
      // extract & run action blocks
      var applied=[]; var clean=txt.replace(/```knap-action\s*([\s\S]*?)```/g,function(_,blk){
        try{ var obj=JSON.parse(blk.trim()); var r=executeAction(obj); if(r)applied.push(r); }catch(e){ applied.push('(could not apply an action: '+e.message+')'); } return ''; });
      clean=clean.replace(/\n{3,}/g,'\n\n').trim();
      var out=clean; if(applied.length) out+= (out?'\n\n':'')+applied.map(function(x){return '✅ '+x;}).join('\n');
      cb(out||'(no reply)');
    })
    .catch(function(e){ cb('⚠️ Could not reach the AI ('+esc(e.message)+'). '+(fallbackHelp||'Try again, or use the offline commands.')); });
  }

  /* =================== UI =================== */
  var CSS=''
  +'.knapas-fab{position:fixed;right:18px;bottom:18px;z-index:99998;background:#173f28;color:#fff;border:none;border-radius:26px;padding:11px 16px;font:600 14px/1 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;display:flex;gap:8px;align-items:center}'
  +'.knapas-fab:hover{background:#1b6a3a}'
  +'.knapas-panel{position:fixed;right:18px;bottom:18px;z-index:99999;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 36px);background:#fff;border:1px solid #d7ddd7;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#141a16}'
  +'.knapas-panel.open{display:flex}'
  +'.knapas-hd{background:#173f28;color:#fff;padding:11px 14px;display:flex;align-items:center;gap:10px}'
  +'.knapas-hd b{font-size:14px} .knapas-hd .sub{font-size:11px;color:#bfe6cd}'
  +'.knapas-hd .sp{margin-left:auto} .knapas-ic{background:none;border:none;color:#cfe6d7;cursor:pointer;font-size:16px;padding:2px 5px;border-radius:6px}'
  +'.knapas-ic:hover{background:rgba(255,255,255,.12);color:#fff}'
  +'.knapas-body{flex:1;overflow:auto;padding:12px;background:#f6f8f6}'
  +'.knapas-msg{margin:0 0 10px;display:flex}.knapas-msg .b{max-width:88%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}'
  +'.knapas-msg.u{justify-content:flex-end}.knapas-msg.u .b{background:#1b6a3a;color:#fff;border-bottom-right-radius:4px}'
  +'.knapas-msg.a .b{background:#fff;border:1px solid #e2e5df;border-bottom-left-radius:4px}'
  +'.knapas-msg.a .b code{background:#eef4ee;padding:1px 4px;border-radius:4px;font-size:12px}'
  +'.knapas-chips{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;background:#eef2ee;border-top:1px solid #e2e5df}'
  +'.knapas-chip{background:#fff;border:1px solid #cfe6d7;color:#1b6a3a;border-radius:14px;padding:4px 10px;font-size:12px;cursor:pointer}'
  +'.knapas-chip:hover{background:#e7f2ea}'
  +'.knapas-in{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e5df;background:#fff}'
  +'.knapas-in textarea{flex:1;resize:none;border:1px solid #d7ddd7;border-radius:8px;padding:8px;font:inherit;height:38px;max-height:120px}'
  +'.knapas-in button{background:#1b6a3a;color:#fff;border:none;border-radius:8px;padding:0 14px;font-weight:600;cursor:pointer}'
  +'.knapas-set{position:absolute;inset:0;background:#fff;display:none;flex-direction:column;overflow:auto}'
  +'.knapas-set.open{display:flex}.knapas-set .in2{padding:14px}'
  +'.knapas-set h4{margin:14px 0 6px;font-size:13px;color:#1b6a3a}.knapas-set label{display:block;font-size:12px;color:#5f6b62;margin:8px 0 3px}'
  +'.knapas-set input,.knapas-set select{width:100%;padding:7px 8px;border:1px solid #d7ddd7;border-radius:7px;font:inherit}'
  +'.knapas-set .warn{background:#fbf1dd;border:1px solid #f0dcb4;color:#6f4410;border-radius:8px;padding:8px 10px;font-size:12px;margin-top:8px}'
  +'.knapas-set .btn{background:#1b6a3a;color:#fff;border:none;border-radius:7px;padding:8px 12px;font-weight:600;cursor:pointer;margin-top:10px}'
  +'.knapas-set .btn.ghost{background:#fff;color:#1b6a3a;border:1px solid #1b6a3a}'
  +'.knapas-list{font-size:12px;border:1px solid #e2e5df;border-radius:8px;max-height:130px;overflow:auto;margin-top:6px}'
  +'.knapas-list div{padding:5px 8px;border-bottom:1px solid #eef0ec}.knapas-list div:last-child{border-bottom:none}';

  function inject(){
    var st=el('style'); st.textContent=CSS; document.head.appendChild(st);

    var fab=el('button','knapas-fab','💬 <span>Assistant</span>'); fab.title='Ask, instruct, teach or leave feedback';
    document.body.appendChild(fab);

    var panel=el('div','knapas-panel');
    panel.innerHTML=''
    +'<div class="knapas-hd"><b>KNAP Assistant</b><span class="sub" id="knapasMode"></span><span class="sp"></span>'
      +'<button class="knapas-ic" id="knapasGear" title="Settings, feedback, learned rules">⚙</button>'
      +'<button class="knapas-ic" id="knapasMin" title="Close">✕</button></div>'
    +'<div class="knapas-body" id="knapasBody"></div>'
    +'<div class="knapas-chips">'
      +'<span class="knapas-chip" data-q="What can you do?">What can you do?</span>'
      +'<span class="knapas-chip" data-q="How do I import last year\'s figures?">Import last year</span>'
      +'<span class="knapas-chip" data-q="switch to Ind AS">Switch to Ind AS</span>'
      +'<span class="knapas-chip" data-q="show figures in lakhs">Figures in lakhs</span>'
      +'<span class="knapas-chip" data-q="feedback: ">Give feedback</span>'
    +'</div>'
    +'<div class="knapas-in"><textarea id="knapasInput" placeholder="Instruct, ask, teach a rule, or leave feedback…"></textarea><button id="knapasSend">Send</button></div>'
    +'<div class="knapas-set" id="knapasSet"><div class="knapas-hd"><b>Settings</b><span class="sp"></span><button class="knapas-ic" id="knapasSetClose">✕</button></div><div class="in2" id="knapasSetBody"></div></div>';
    document.body.appendChild(panel);

    var body=$('knapasBody');
    function addMsg(who,text){ var m=el('div','knapas-msg '+(who==='u'?'u':'a')); m.appendChild(el('div','b',renderText(text))); body.appendChild(m); body.scrollTop=body.scrollHeight; return m; }
    function renderText(t){ return esc(t).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>'); }

    // greeting / restore
    var chat=lsJSON('knap-chat',[]); if(!Array.isArray(chat))chat=[];
    if(chat.length){ chat.slice(-30).forEach(function(m){ addMsg(m.who,m.text); }); }
    else { addMsg('a','Hi! I’m your finprep assistant. I can change the tool (“switch to Ind AS”, “show figures in lakhs”, “group Salary under Employee benefits”), teach it rules (“always treat ‘freight’ as Other expenses”), answer how-to questions, and log your feedback. I work offline — enable the AI in ⚙ for free-form answers.'); }
    function persist(who,text){ chat.push({who:who,text:text}); if(chat.length>60)chat=chat.slice(-60); lsSet('knap-chat',JSON.stringify(chat)); }

    function send(text){ var t=(text!=null?text:$('knapasInput').value).trim(); if(!t)return;
      addMsg('u',t); persist('u',t); $('knapasInput').value='';
      var thinking=addMsg('a','…');
      respond(t,function(reply){ thinking.querySelector('.b').innerHTML=renderText(reply||''); persist('a',reply||''); body.scrollTop=body.scrollHeight; });
    }
    function refreshMode(){ $('knapasMode').textContent=(CFG.apiEnabled?'AI + offline':'offline'); }
    refreshMode();

    fab.onclick=function(){ panel.classList.add('open'); fab.style.display='none'; $('knapasInput').focus(); };
    $('knapasMin').onclick=function(){ panel.classList.remove('open'); fab.style.display='flex'; };
    $('knapasSend').onclick=function(){ send(); };
    $('knapasInput').addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
    panel.querySelectorAll('.knapas-chip').forEach(function(c){ c.onclick=function(){ var q=c.getAttribute('data-q'); if(q==='feedback: '){ $('knapasInput').value='feedback: '; $('knapasInput').focus(); } else send(q); }; });

    /* ----- settings drawer ----- */
    var setBox=$('knapasSet');
    $('knapasGear').onclick=function(){ renderSettings(); setBox.classList.add('open'); };
    $('knapasSetClose').onclick=function(){ setBox.classList.remove('open'); };
    function renderSettings(){
      var lr=(window.__learnRules||[]);
      var fb=lsJSON('knap-feedback',[]); if(!Array.isArray(fb))fb=[];
      var b=$('knapasSetBody');
      b.innerHTML=''
        +'<h4>AI engine (optional)</h4>'
        +'<label><input type="checkbox" id="knapasApiOn"'+(CFG.apiEnabled?' checked':'')+'> Enable free-form answers via the Anthropic API</label>'
        +'<div class="warn">Offline mode keeps everything on this machine. Enabling the API sends your messages and a tool summary (company name, framework, ledger <b>names</b> — no amounts) to Anthropic over the internet. Use your own API key.</div>'
        +'<label>API key (stored only in this browser)</label><input type="password" id="knapasApiKey" placeholder="sk-ant-…" value="'+esc(CFG.apiKey||'')+'">'
        +'<label>Model</label><input type="text" id="knapasModel" value="'+esc(CFG.model||'claude-haiku-4-5-20251001')+'">'
        +'<label>When to use AI</label><select id="knapasApiMode"><option value="offline"'+(CFG.mode==='offline'?' selected':'')+'>Offline first — AI only when I have no built-in answer</option><option value="ai"'+(CFG.mode==='ai'?' selected':'')+'>Prefer AI for questions</option></select>'
        +'<button class="btn" id="knapasSaveCfg">Save settings</button>'
        +'<h4>Learned grouping rules ('+lr.length+')</h4>'
        +'<div class="knapas-list" id="knapasRules">'+(lr.length?lr.map(function(r,i){return '<div>“'+esc(r.kw)+'” → '+esc(headName(r.note))+' <a href="#" data-del="'+i+'" style="color:#b42318;float:right">remove</a></div>';}).join(''):'<div>None yet. Teach me: “always treat ‘freight’ as Other expenses”.</div>')+'</div>'
        +'<h4>Feedback log ('+fb.length+')</h4>'
        +'<div class="knapas-list">'+(fb.length?fb.slice(-8).reverse().map(function(f){return '<div><b>'+esc(f.kind)+'</b> · '+esc((f.ts||'').slice(0,10))+'<br>'+esc(f.text)+'</div>';}).join(''):'<div>No feedback yet.</div>')+'</div>'
        +'<div><button class="btn ghost" id="knapasExportFb">⬇ Export feedback</button> <button class="btn ghost" id="knapasCopyFb">Copy all</button> <button class="btn ghost" id="knapasClearFb">Clear</button></div>';
      $('knapasSaveCfg').onclick=function(){ CFG.apiEnabled=$('knapasApiOn').checked; CFG.apiKey=$('knapasApiKey').value.trim(); CFG.model=$('knapasModel').value.trim()||'claude-haiku-4-5-20251001'; CFG.mode=$('knapasApiMode').value; saveCfg(); refreshMode(); setBox.classList.remove('open'); addMsg('a',CFG.apiEnabled?'AI enabled. I’ll use it for free-form questions; the offline commands still work instantly.':'Running fully offline.'); };
      b.querySelectorAll('[data-del]').forEach(function(a){ a.onclick=function(e){ e.preventDefault(); var i=+a.getAttribute('data-del'); window.__learnRules.splice(i,1); lsSet('knap-learn',JSON.stringify(window.__learnRules)); knapRefreshAll(); renderSettings(); }; });
      $('knapasExportFb').onclick=function(){ var blob=new Blob([JSON.stringify(fb,null,2)],{type:'application/json'}); var a=el('a'); a.href=URL.createObjectURL(blob); a.download='knap-finprep-feedback.json'; a.click(); setTimeout(function(){URL.revokeObjectURL(a.href);},1500); };
      $('knapasCopyFb').onclick=function(){ try{ navigator.clipboard.writeText(fb.map(function(f){return '['+f.kind+' '+(f.ts||'').slice(0,10)+'] '+f.text;}).join('\n')); $('knapasCopyFb').textContent='Copied'; }catch(e){} };
      $('knapasClearFb').onclick=function(){ if(confirm('Clear all logged feedback?')){ lsSet('knap-feedback','[]'); renderSettings(); } };
    }
  }

  // namespaced hooks for automated tests (harmless in production)
  window.__knapAssistantAPI={parseAction:parseAction,noteFromText:noteFromText,executeAction:executeAction,helpAnswer:helpAnswer,findLedger:findLedger,respond:respond,addLearn:addLearn};

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',inject); else inject();
})();
