"""Track a person in a video: 33 body points per frame, saved as JSON for video-to-clip.js.

Usage (from the project folder):
    python prototype/tools/track_video.py VIDEO CX CY SIZE OUT.json

CX, CY, SIZE: a square around the person in video pixels (centre and side length). The person
should stay inside it for the whole clip. For pull-up.mp4 (a 1920x1080 screen recording) the
square was 712 640 760.

Needs: numpy, ai-edge-litert (pip install ai-edge-litert), ffmpeg on PATH, and the model file
pose_landmark_full.tflite next to this script. The model is Google's MediaPipe BlazePose (Apache 2.0).
To get it without a Google download, pull it out of an older mediapipe package:
    pip download mediapipe==0.10.14 --python-version 3.11 --only-binary=:all: --no-deps
    then copy mediapipe/modules/pose_landmark/pose_landmark_full.tflite out of the .whl (it is a zip).

Output per frame:
    img:   33 points as [x, y, z] inside the square (0 to 1)
    vis:   how sure the tracker is each point is visible (0 to 1)
    world: 33 points in metres around the hips (the tracker's own 3D guess)
    flag:  how sure it is a person is there at all
"""
import json, os, subprocess, sys
import numpy as np
from ai_edge_litert.interpreter import Interpreter

video, cx, cy, size, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
model = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pose_landmark_full.tflite')
it = Interpreter(model_path=model); it.allocate_tensors()
inp = it.get_input_details()[0]['index']; outs = {d['name']: d['index'] for d in it.get_output_details()}

fps = eval(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
                           '-of', 'csv=p=0', video], capture_output=True, text=True).stdout.strip())
x0, y0 = cx - size // 2, cy - size // 2
# pad first so the square may run past the video edge, then cut it out and scale to the model's 256x256
cmd = ['ffmpeg', '-v', 'error', '-i', video, '-vf', f'pad=iw+2000:ih+2000:1000:1000,crop={size}:{size}:{x0 + 1000}:{y0 + 1000},scale=256:256',
       '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
raw = subprocess.run(cmd, capture_output=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, 256, 256, 3)

res = []
for f in frames:
    it.set_tensor(inp, (f.astype(np.float32) / 255)[None]); it.invoke()
    lm = it.get_tensor(outs['Identity']).reshape(39, 5)        # 39 points: x, y, z (pixels), visibility, presence
    wl = it.get_tensor(outs['Identity_4']).reshape(39, 3)      # same points in metres
    flag = float(it.get_tensor(outs['Identity_1'])[0, 0])
    res.append(dict(img=(lm[:33, :3] / 256).round(4).tolist(), vis=(1 / (1 + np.exp(-lm[:33, 3]))).round(3).tolist(),
                    world=wl[:33].round(4).tolist(), flag=round(flag, 3)))
json.dump(dict(video=os.path.basename(video), fps=fps, crop=[x0, y0, size], frames=res), open(out, 'w'))
print(len(res), 'frames at', fps, 'fps ->', out)
