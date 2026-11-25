from PIL import Image, ImageDraw, ImageFilter
import math, os
N=1080; S=4; W=N*S
def round_corners(mask, r):
    # Rounds convex corners: blur the shape, cut at half. Edges stay put; only corners soften.
    return mask.filter(ImageFilter.GaussianBlur(r)).point(lambda v: 255 if v>=128 else 0)
def finish(shape,name):
    img=Image.eval(shape,lambda v:255-v).resize((N,N),Image.LANCZOS)
    q=img.point(lambda v: round(v/17)*17)
    p=q.convert('P',palette=Image.ADAPTIVE,colors=16)
    p.save(name,optimize=True,bits=4)
    print(name,os.path.getsize(name))

# Start: a player's play triangle, optically centred (centroid on the centre).
m=Image.new('L',(W,W),0); d=ImageDraw.Draw(m)
h=0.48*W; w=h*math.sqrt(3)/2
cx=W/2+w/6; cy=W/2   # centroid of the triangle sits on the centre
d.polygon([(cx-w*2/3,cy-h/2),(cx+w/3,cy),(cx-w*2/3,cy+h/2)],fill=255)
finish(round_corners(m,0.022*W),'soty-restitch-start.png')

# End: a big, plain down arrow.
m=Image.new('L',(W,W),0); d=ImageDraw.Draw(m)
total=0.54*W; shaft=0.16*W; head_w=0.48*W; head_h=0.25*W
top=W/2-total/2; bottom=W/2+total/2; x=W/2
d.rectangle([x-shaft/2,top,x+shaft/2,bottom-head_h+1],fill=255)
d.polygon([(x-head_w/2,bottom-head_h),(x+head_w/2,bottom-head_h),(x,bottom)],fill=255)
finish(round_corners(m,0.016*W),'soty-restitch-end.png')
