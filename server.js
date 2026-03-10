// Already includes Express, Socket.IO, Cloudinary, multer, fs, bcrypt
// Keep your existing users & chat logic intact

// ── Clip upload (Cloudinary) ──
app.post('/upload-clip', multer({ storage: multer.memoryStorage() }).single('clip'), async (req,res)=>{
  const file = req.file;
  const uploader = (req.body.uploader||'unknown').trim();
  if(!file) return res.status(400).json({success:false,message:'No file uploaded'});
  try{
    const baseName = file.originalname.replace(/\.[^.]+$/,'');
    const result = await new Promise((resolve,reject)=>{
      const stream = cloudinary.uploader.upload_stream({
        resource_type:'video', folder:'hatchat-clips', public_id:baseName, overwrite:false,
        tags:[`uploader:${uploader}`], context:`uploader=${uploader}`
      }, (err,r)=>err?reject(err):resolve(r));
      stream.end(file.buffer);
    });
    res.json({ success:true, filename:file.originalname, url:result.secure_url, public_id:result.public_id, uploader });
  }catch(e){ console.error(e); res.status(500).json({success:false,message:e.message}); }
});

// GET /api/clips
app.get('/api/clips', async (req,res)=>{
  try{
    const result = await cloudinary.api.resources({ resource_type:'video', type:'upload', prefix:'hatchat-clips/', max_results:200, context:true, tags:true });
    const clips = result.resources.map(r=>{
      let uploader='unknown';
      if(r.context?.custom?.uploader) uploader=r.context.custom.uploader;
      else if(r.tags) { const t=r.tags.find(t=>t.startsWith('uploader:')); if(t) uploader=t.replace('uploader:',''); }
      return { filename:path.basename(r.public_id)+'.'+r.format, url:r.secure_url, public_id:r.public_id, created_at:r.created_at, uploader };
    });
    clips.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    res.json({ success:true, clips });
  }catch(e){ console.error(e); res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/clips/:public_id
app.delete('/api/clips/:public_id(*)', async (req,res)=>{
  const { public_id } = req.params; const { uploader } = req.body||{};
  if(!uploader) return res.status(400).json({success:false,message:'Missing uploader'});
  try{
    const info = await cloudinary.api.resource(public_id, { resource_type:'video', context:true, tags:true });
    let owner = info.context?.custom?.uploader || (info.tags?.find(t=>t.startsWith('uploader:'))?.replace('uploader:','')) || 'unknown';
    if(owner.toLowerCase()!==uploader.toLowerCase()) return res.status(403).json({success:false,message:'Can only delete your own clips'});
    await cloudinary.uploader.destroy(public_id,{ resource_type:'video' });
    res.json({success:true});
  }catch(e){ console.error(e); res.status(500).json({success:false,message:e.message}); }
});