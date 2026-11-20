# Gera os ícones do Playset. Rodar na pasta do app: python3 icons/gerar-icones.py  (precisa de Pillow)
from PIL import Image, ImageDraw
BG=(0x12,0x14,0x17,255); GOLD=(0xf2,0xc7,0x5c,255)
def card(size, scale, fill, outline=None, w=0, angle=0, dx=0, dy=0):
    W=size; cw=int(W*0.36*scale); ch=int(cw*680/488)
    layer=Image.new('RGBA',(W,W),(0,0,0,0)); d=ImageDraw.Draw(layer)
    x0=(W-cw)//2; y0=(W-ch)//2; r=int(cw*0.09)
    d.rounded_rectangle([x0,y0,x0+cw,y0+ch],r,fill=fill,outline=outline,width=w)
    layer=layer.rotate(angle,resample=Image.BICUBIC,center=(W/2,W/2))
    out=Image.new('RGBA',(W,W),(0,0,0,0)); out.paste(layer,(int(dx*W),int(dy*W)),layer); return out
def icon(px, scale):
    S=px*4
    im=Image.new('RGBA',(S,S),BG)
    for fill,ang,dx,dy,ol in [((0x4a,0x4e,0x57,255),16,-0.10,0.01,None),((0x6e,0x72,0x7b,255),4,-0.03,-0.005,None),((0x1e,0x21,0x26,255),-10,0.08,0.0,GOLD)]:
        im=Image.alpha_composite(im, card(S,scale,fill,ol,int(S*0.022*scale) if ol else 0,ang,dx*scale,dy*scale))
    return im.resize((px,px),Image.LANCZOS)
icon(192,1.0).save('icons/icon-192.png'); icon(512,1.0).save('icons/icon-512.png')
icon(512,0.78).save('icons/icon-maskable-512.png')
