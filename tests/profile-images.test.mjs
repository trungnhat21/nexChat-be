import "dotenv/config";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Module, BadRequestException, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { createAccessToken } from "../dist/utils/token.js";
import { ProfileImagesService } from "../dist/profile/profile-images.service.js";
import { ProfileImagesController } from "../dist/profile/profile-images.controller.js";
import { PrismaService } from "../dist/prisma/prisma.service.js";
import { PostStorageService } from "../dist/posts/post-storage.service.js";
import { PostsService } from "../dist/posts/posts.service.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=","base64");
const file={originalname:"avatar.png",mimetype:"image/png",size:png.length,buffer:png};

test("rejects missing/invalid images, wrong kinds, unsupported types and large files before upload",async()=>{
    let uploads=0;const service=new ProfileImagesService({}, {upload:async()=>{uploads++;}}, {});
    for(const [kind,image]of [["unknown",file],["avatar",undefined],["avatar",{...file,mimetype:"image/svg+xml"}],["cover",{...file,size:11*1024*1024}],["avatar",{...file,mimetype:"image/jpeg"}]]){
        await assert.rejects(service.upload(1n,kind,image),BadRequestException);
    }
    assert.equal(uploads,0);
    const missing=new ProfileImagesService({users:{findFirst:async()=>null}},{upload:async()=>{uploads++;}},{});
    await assert.rejects(missing.upload(1n,"avatar",file),NotFoundException);assert.equal(uploads,0);
});
test("cleans new MinIO objects if saving the profile fails",async()=>{
    const removed=[];const service=new ProfileImagesService({users:{findFirst:async()=>({id:1n})},$transaction:async()=>{throw Error("database failure");}},
        {upload:async()=>({key:"profiles/1/new.png"}),remove:async keys=>removed.push(...keys)},{});
    await assert.rejects(service.upload(1n,"avatar",file),/database failure/);assert.deepEqual(removed,["profiles/1/new.png"]);
});
test("profile image HTTP endpoint requires auth, uses session ID and accepts one multipart image",async()=>{
    const calls=[];const images={upload:async(userId,kind,image)=>{calls.push({userId,kind,image});return {success:true,kind,url:"https://example.invalid/avatar.png"};}};
    class TestModule{};Module({controllers:[ProfileImagesController],providers:[AuthGuard,{provide:AuthService,useValue:{getSessionCurrentUser:async(session,id)=>session==="profile-image-test"&&id===1n?{id:"1"}:null}},{provide:ProfileImagesService,useValue:images}]})(TestModule);
    const app=await NestFactory.create(TestModule,{logger:false});await app.listen(0,"127.0.0.1");const base=await app.getUrl();
    const headers={Authorization:"Bearer "+createAccessToken(1n,"profile-image-test")};
    try{
        assert.equal((await fetch(base+"/api/profile/images/avatar",{method:"PATCH"})).status,401);
        const form=new FormData();form.append("image",new Blob([png],{type:"image/png"}),"avatar.png");
        assert.equal((await fetch(base+"/api/profile/images/avatar",{method:"PATCH",headers,body:form})).status,200);
        assert.equal(calls[0].userId,1n);assert.equal(calls[0].kind,"avatar");assert.deepEqual(calls[0].image.buffer,png);
        const injected=new FormData();injected.append("image",new Blob([png],{type:"image/png"}),"avatar.png");injected.set("userId","2");
        assert.equal((await fetch(base+"/api/profile/images/avatar",{method:"PATCH",headers,body:injected})).status,400);
        const extra=new FormData();extra.append("image",new Blob([png],{type:"image/png"}),"one.png");extra.append("image",new Blob([png],{type:"image/png"}),"two.png");
        assert.equal((await fetch(base+"/api/profile/images/avatar",{method:"PATCH",headers,body:extra})).status,400);
    }finally{await app.close();}
});
test("real MySQL/MinIO persists avatar and cover, signs read URLs and removes replaced images; fixtures roll back",{skip:process.env.PROFILE_IMAGE_INTEGRATION!=="1"},async()=>{
    const prisma=new PrismaService(),storage=new PostStorageService();const uploaded=[];const marker="profile-images-"+crypto.randomUUID();const rollback=new Error("ROLLBACK_IMAGE_TEST");
    const store={upload:async(...args)=>{const value=await storage.upload(...args);uploaded.push(value.key);return value;},url:(...args)=>storage.url(...args),remove:(...args)=>storage.remove(...args)};
    const graphUpdates=[];
    try{
        await assert.rejects(prisma.$transaction(async tx=>{
            const user=await tx.users.create({data:{email:marker+"@example.invalid",password_hash:"test-only",first_name:"Image",last_name:"Test"}});
            await tx.profiles.create({data:{user_id:user.id,display_name:"Existing name",bio:"Existing bio"}});
            const adapter=new Proxy(tx,{get(target,key){return key==="$transaction"?callback=>callback(tx):target[key];}});
            const users={syncProfileImage:async value=>graphUpdates.push(value.avatar),getUserById:async id=>tx.users.findUnique({where:{id}}),getUserByEmail:async()=>tx.users.findUnique({where:{id:user.id}})};
            const images=new ProfileImagesService(adapter,store,users);
            const first=await images.upload(user.id,"avatar",file);
            assert.equal((await fetch(first.url)).status,200);
            const avatarKey=(await tx.users.findUnique({where:{id:user.id}})).avatar;assert.ok(avatarKey.startsWith("profiles/"+user.id+"/"));
            let profile=await tx.profiles.findUnique({where:{user_id:user.id}});assert.equal(profile.avatar_url,avatarKey);assert.equal(profile.display_name,"Existing name");assert.equal(profile.bio,"Existing bio");
            const cover=await images.upload(user.id,"cover",file);const coverResponse=await fetch(cover.url);assert.equal(coverResponse.status,200);assert.equal(coverResponse.headers.get("content-type"),"image/png");
            profile=await tx.profiles.findUnique({where:{user_id:user.id}});assert.ok(profile.cover_url.startsWith("profiles/"+user.id+"/"));assert.equal(profile.avatar_url,avatarKey);
            const cache=new Map();const auth=new AuthService(adapter,{get:async key=>cache.get(key),set:async(key,value)=>{cache.set(key,value);}},users,store);
            auth.comparePassword=async()=>true;
            const session=await auth.login(user.email,"test-only");assert.equal(session.kind,"authenticated");assert.ok(session.currentUser.avatar.startsWith("http"));assert.equal((await fetch(session.currentUser.avatar)).status,200);
            const refreshed=await auth.refresh(session.refreshToken);assert.ok(refreshed.currentUser.avatar.startsWith("http"));
            const second=await images.upload(user.id,"avatar",file);assert.equal((await fetch(first.url)).status,404);assert.equal((await fetch(second.url)).status,200);assert.equal(graphUpdates.length,2);
            const reloaded=await auth.getCurrentUser(user.id);assert.equal((await fetch(reloaded.avatar)).status,200);
            const feed=await new PostsService(adapter,store).list(user.id,undefined,"",user.id);assert.equal((await fetch(feed.author.avatar)).status,200);assert.equal((await fetch(feed.author.cover)).status,200);
            throw rollback;
        },{timeout:120000}),error=>error===rollback);
        assert.equal(await prisma.users.count({where:{email:marker+"@example.invalid"}}),0);
    }finally{await storage.remove(uploaded);storage.onModuleDestroy();await prisma.$disconnect();}
});
