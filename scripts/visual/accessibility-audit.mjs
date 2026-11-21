/** Rendered flat-color contrast and browser accessibility evidence; never NVDA certification. */
export async function accessibilityAudit(page) {
  const rendered = await page.evaluate(`(() => {
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);const [r,g,b,a]=context.getImageData(0,0,1,1).data;return [r,g,b,a/255]};
    const over=(front,back)=>{const a=front[3]+back[3]*(1-front[3]);return a===0?[0,0,0,0]:[0,1,2].map(i=>(front[i]*front[3]+back[i]*back[3]*(1-front[3]))/a).concat(a)};
    const luminance=color=>color.slice(0,3).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const samples=[],unmeasured=[];
    const modal=document.querySelector('[aria-modal=true]');
    const elements=[...document.querySelectorAll('body *')].filter(e=>{
      if(!(e instanceof HTMLElement)||['SCRIPT','STYLE','SVG'].includes(e.tagName)||e.closest('[inert],[aria-hidden=true]'))return false;
      if(modal&&!modal.contains(e))return false;
      const r=e.getBoundingClientRect();if(!r.width||!r.height||r.bottom<0||r.top>innerHeight)return false;
      const style=getComputedStyle(e);if(style.visibility==='hidden'||style.display==='none')return false;
      return [...e.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())||e.matches('textarea,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select');
    });
    for(const element of elements){
      const style=getComputedStyle(element),placeholder=element instanceof HTMLInputElement&&!element.value&&element.placeholder;
      const textColor=placeholder?getComputedStyle(element,'::placeholder').color:style.color;
      let foreground=rgba(textColor),background=[0,0,0,0],gradient=false,hidden=false;
      for(let current=element;current;current=current.parentElement){
        const s=getComputedStyle(current);if(s.display==='none'||Number(s.opacity)===0){hidden=true;break;}
        if(s.backgroundImage!=='none')gradient=true;
        const paint=rgba(s.backgroundColor);
        foreground=over(foreground,paint);background=over(background,paint);
        foreground[3]*=Number(s.opacity);background[3]*=Number(s.opacity);
      }
      if(hidden)continue;
      const text=(placeholder||element.value||[...element.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(' ')).trim().slice(0,140);
      if(!text)continue;
      if(gradient){unmeasured.push({text,reason:'gradient/backdrop requires separate painted-background review'});continue;}
      foreground=over(foreground,[255,255,255,1]);background=over(background,[255,255,255,1]);
      const values=[luminance(foreground),luminance(background)].sort((a,b)=>b-a),ratio=(values[0]+.05)/(values[1]+.05);
      const required=parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.66&&Number(style.fontWeight)>=700)?3:4.5;
      const disabled=element.matches(':disabled')||!!element.closest('[aria-disabled=true]');
      samples.push({text,tag:element.tagName,placeholder:!!placeholder,fontSize:style.fontSize,fontWeight:style.fontWeight,foreground,background,ratio:Number(ratio.toFixed(3)),required,disabled,pass:disabled||ratio+.005>=required});
    }
    return {samples,unmeasured,failures:samples.filter(s=>!s.pass),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},modal:modal?.getAttribute('aria-label')??null};
  })()`);
  const tree = await page.send('Accessibility.getFullAXTree');
  const nodes=(tree.result?.nodes??[]).filter(node=>!node.ignored).map(({role,name,properties})=>({role:role?.value,name:name?.value,properties}));
  return {...rendered, accessibilityTree:nodes, scope:'Visible text on flat composited backgrounds; disabled text measured but exempt. Browser AX tree is not an NVDA announcement record.'};
}
