"""Offline layered states from the two cached fal cutouts (no paid calls).
before/active/result = case + subtle preload glow; lock-body / lock-shackle are
separate motion layers on the SAME canvas so Studio and Python place them alike."""
from pathlib import Path
from PIL import Image, ImageFilter, ImageEnhance, ImageDraw
ROOT=Path(__file__).resolve().parents[2]
P=ROOT/"public/overlay-library/clean-tech/case-lock"
W,H=640,720
CASE_AT,CASE_H=(50,40),560
LOCK_H,LOCK_AT=330,(380,345)
SPLIT=262  # first row of the lock body's top face in lock.png

def place(im,h):
    return im.resize((round(im.width*h/im.height),h),Image.Resampling.LANCZOS)

def main():
    case=place(Image.open(P/"case.png").convert("RGBA"),CASE_H)
    shell=Image.new("RGBA",(W,H)); shell.alpha_composite(case,CASE_AT)
    a=shell.getchannel("A").filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(16))
    glow=Image.new("RGBA",(W,H),(190,242,70,0)); glow.putalpha(a.point(lambda v:int(v*.62)))
    dim=Image.new("RGBA",(W,H)); dim.alpha_composite(ImageEnhance.Brightness(ImageEnhance.Color(case).enhance(.55)).enhance(.78),CASE_AT)
    Image.alpha_composite(Image.new("RGBA",(W,H)),dim).save(P/"before.png")
    lit=Image.new("RGBA",(W,H)); lit.alpha_composite(glow); lit.alpha_composite(shell)
    lit.save(P/"active.png"); lit.save(P/"result.png")
    lock=Image.open(P/"lock.png").convert("RGBA")
    al=lock.getchannel("A"); legs=[x for x in range(lock.width) if al.getpixel((x,SPLIT-20))>100]
    shackle=Image.new("RGBA",lock.size); body=lock.copy()
    TOP=SPLIT-13  # body silhouette starts here; everything above is shackle
    shackle.paste(lock.crop((0,0,lock.width,TOP)),(0,0))
    body.paste(Image.new("RGBA",(lock.width,TOP)),(0,0))
    for x in legs:
        for y in range(TOP,SPLIT):
            px=lock.getpixel((x,y)); shackle.putpixel((x,y),px)
            if True:  # replace leg pixels on the top face with face colour
                src=min(legs)-6 if x<(min(legs)+max(legs))//2 else max(legs)+6
                body.putpixel((x,y),lock.getpixel((src,y)) if y>=SPLIT-12 else (0,0,0,0))
            else: body.putpixel((x,y),(0,0,0,0))
    d=ImageDraw.Draw(body)
    mid=(min(legs)+max(legs))//2
    for grp in ([x for x in legs if x<mid],[x for x in legs if x>=mid]):
        d.ellipse((min(grp),SPLIT-9,max(grp),SPLIT-1),fill=(22,24,26,255))
    for name,im in (("lock-body",body),("lock-shackle",shackle)):
        out=Image.new("RGBA",(W,H)); out.alpha_composite(place(im,LOCK_H),LOCK_AT); out.save(P/f"{name}.png")
if __name__=="__main__":main()
