// Replace each null with a relative image path when screenshots are supplied.
const screenshots={hero:null,roster:null,gameplay:null,loader:null,editor:null};
for(const [slot,path] of Object.entries(screenshots)){if(!path)continue;const frame=slot==='hero'?document.querySelector('.hero-art .shot'):document.querySelector(`[data-slot="${slot}"]`);const placeholder=frame.querySelector('.placeholder');const image=new Image();image.alt=placeholder.querySelector('strong').textContent;image.loading=slot==='hero'?'eager':'lazy';image.onload=()=>placeholder.replaceWith(image);image.src=path;}
