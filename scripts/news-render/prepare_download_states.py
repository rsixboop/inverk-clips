"""Offline deterministic states from the single cached fal illustration."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[2]
PATH=ROOT/"public/overlay-library/clean-tech/300b6a9bc7ed8b4"
def main():
    with Image.open(PATH/"overlay.png") as image:
        body=image.crop((25,143,502,325)).resize((720,125))
        shackle=image.crop((445,15,618,220)).resize((116,130))
    font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",23)
    for name,full,closed in [("before",False,False),("active",True,False),("result",True,True)]:
        out=Image.new("RGBA",(720,180));out.alpha_composite(body,(0,45));draw=ImageDraw.Draw(out)
        if full:
            draw.rounded_rectangle((78,82,611,120),radius=12,fill=(188,239,63,255))
            draw.line((90,88,595,88),fill=(235,255,151,220),width=3)
        draw.text((280,90),"GTA VI",font=font,fill=(24,31,26,255) if full else (240,245,234,255))
        out.alpha_composite(shackle,(557,22 if closed else 0));out.save(PATH/(name+".png"))
if __name__=="__main__":main()