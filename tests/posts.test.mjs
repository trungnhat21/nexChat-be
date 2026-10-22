import "dotenv/config";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Module, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { createAccessToken } from "../dist/utils/token.js";
import { PostsController } from "../dist/posts/posts.controller.js";
import { PostsService } from "../dist/posts/posts.service.js";
import { PostStorageService } from "../dist/posts/post-storage.service.js";
import { parseId, parseMutation, validateMedia } from "../dist/posts/posts.validation.js";
import { PrismaService } from "../dist/prisma/prisma.service.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const file = { originalname: "pixel.png", mimetype: "image/png", size: png.length, buffer: png };
const input = content => parseMutation({ content, privacy: "public", keepMediaIds: "[]" });

test("rejects invalid IDs, injected media IDs and malformed mutation bodies", () => {
    for (const value of ["0", "-1", "1.1", "18446744073709551616", "1 OR 1=1", 1, null]) assert.throws(() => parseId(value), BadRequestException);
    for (const body of [{content:"x",privacy:"unknown"},{content:"x",keepMediaIds:'["1","1"]'},{content:"x",keepMediaIds:"{}"},{content:"x",keepMediaIds:'["-1"]'},{content:"x".repeat(5001)}, { content: {} }]) assert.throws(() => parseMutation(body), BadRequestException);
    assert.deepEqual(parseMutation({content:"  hello  ",privacy:"private",keepMediaIds:'["12"]'}),{content:"hello",privacy:"private",keepMediaIds:[12n]});
});
test("validates binary signatures, empty files and per-file/combined upload limits", () => {
    validateMedia([file]);
    assert.throws(() => validateMedia([{...file,mimetype:"video/mp4"}]), BadRequestException);
    assert.throws(() => validateMedia([{...file,mimetype:"image/svg+xml"}]), BadRequestException);
    assert.throws(() => validateMedia([{...file,size:0,buffer:Buffer.alloc(0)}]), BadRequestException);
    assert.throws(() => validateMedia(Array(6).fill(file)), BadRequestException);
    assert.throws(() => validateMedia([{...file,size:26*1024*1024}]), BadRequestException);
    assert.throws(() => validateMedia(Array(3).fill({...file,size:20*1024*1024})), BadRequestException);
});
test("checks ownership before uploads and cleans files after partial upload or database failure", async () => {
    let uploads = 0; const removed = [];
    const storage = { upload: async () => { uploads++; return {key:"test-key",name:"pixel.png",size:png.length,type:"image/png"}; }, remove: async keys => removed.push(...keys) };
    const foreign = new PostsService({posts:{findFirst:async()=>({user_id:2n})}},storage);
    await assert.rejects(foreign.update(1n,1n,input("x"),[file]),ForbiddenException);
    await assert.rejects(foreign.remove(1n,1n),ForbiddenException);
    assert.equal(uploads,0);
    const failure = new PostsService({$transaction:async()=>{throw new Error("database unavailable");}},storage);
    await assert.rejects(failure.create(1n,input("x"),[file]),/database unavailable/);
    assert.deepEqual(removed,["test-key"]);
    let count=0; const cleaned=[];
    const partial = new PostsService({}, {upload:async()=>{if(++count===2)throw new Error("storage unavailable");return {key:"first-key"};},remove:async keys=>cleaned.push(...keys)});
    await assert.rejects(partial.create(1n,input("x"),[file,file]),/storage unavailable/);
    assert.deepEqual(cleaned,["first-key"]);
});

test("HTTP guard, multipart parsing and body validation work together", async () => {
    const calls=[];
    const service={create:async(userId,body,files)=>{validateMedia(files);calls.push({userId,body,files});return {success:true,post:{id:"1"}};},list:async()=>({success:true,posts:[],nextCursor:null}),update:async()=>({success:true}),remove:async()=>({success:true})};
    const session={getSessionCurrentUser:async(sessionId,userId)=>sessionId==="posts-test"&&userId===1n?{id:"1"}:null};
    class TestModule {}
    Module({controllers:[PostsController],providers:[AuthGuard,{provide:AuthService,useValue:session},{provide:PostsService,useValue:service}]})(TestModule);
    const app=await NestFactory.create(TestModule,{logger:false});await app.listen(0,"127.0.0.1");
    const base=await app.getUrl();
    const token=createAccessToken(1n,"posts-test");
    try {
        assert.equal((await fetch(base+"/api/posts")).status,401);
        assert.equal((await fetch(base+"/api/posts",{headers:{Authorization:"Bearer "+createAccessToken(1n,"expired-session")}})).status,401);
        const form=new FormData();form.set("content"," Hello ");form.set("privacy","public");form.set("keepMediaIds","[]");form.append("media",new Blob([png],{type:"image/png"}),"pixel.png");
        const result=await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:form});
        assert.equal(result.status,201);assert.equal(calls[0].userId,1n);assert.equal(calls[0].body.content,"Hello");assert.equal(calls[0].files[0].buffer.length,png.length);
        assert.equal((await fetch(base+"/api/posts/not-an-id",{method:"DELETE",headers:{Authorization:"Bearer "+token}})).status,400);
        const invalid=new FormData();invalid.set("content","x");invalid.append("media",new Blob(["not png"],{type:"image/png"}),"fake.png");
        assert.equal((await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:invalid})).status,400);
        const tooMany=new FormData();tooMany.set("content","x");for(let i=0;i<6;i++)tooMany.append("media",new Blob([png],{type:"image/png"}),"pixel.png");
        assert.equal((await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:tooMany})).status,400);
    } finally { await app.close(); }
});

test("real database: CRUD, privacy, search, pagination and attachment ownership; all fixtures roll back", {skip:process.env.POSTS_DB_TESTS!=="1"}, async()=>{
    const prisma=new PrismaService(); const marker="posts-test-"+crypto.randomUUID(); const rollback=new Error("ROLLBACK_TEST_FIXTURES");
    const removed=[];let sequence=0;
    const storage={upload:async(_,f)=>({key:"posts/1/"+(++sequence)+".png",type:f.mimetype,name:f.originalname,size:f.size}),url:async key=>"https://media.example.invalid/"+key,remove:async keys=>removed.push(...keys)};
    try {
        await assert.rejects(prisma.$transaction(async tx=>{
            const user1=await tx.users.create({data:{email:marker+"-1@example.invalid",password_hash:"test-only",first_name:"Actor",last_name:"Test"}});
            const user2=await tx.users.create({data:{email:marker+"-2@example.invalid",password_hash:"test-only"}});
            const user3=await tx.users.create({data:{email:marker+"-3@example.invalid",password_hash:"test-only"}});
            await tx.friendships.create({data:{requester_id:user1.id,addressee_id:user2.id,status:"accepted"}});
            const adapter=new Proxy(tx,{get(target,key){return key==="$transaction" ? callback=>callback(tx) : target[key];}});
            const service=new PostsService(adapter,storage);
            const created=await service.create(user1.id,input(marker),[file]);
            const id=BigInt(created.post.id);const attachment=created.post.media[0];
            assert.equal(created.post.author.name,"Test Actor");assert.equal(created.post.canEdit,true);assert.equal(created.post.media.length,1);
            const stranger=await service.list(user3.id,undefined,marker);assert.equal(stranger.posts.length,1);assert.equal(stranger.posts[0].canEdit,false);
            await assert.rejects(service.update(user2.id,id,input("attack"),[]),ForbiddenException);
            await assert.rejects(service.remove(user2.id,id),ForbiddenException);
            const edited=await service.update(user1.id,id,{...input(marker+" edited"),privacy:"friends",keepMediaIds:[BigInt(attachment.id)]},[]);
            assert.equal(edited.post.media[0].id,attachment.id);
            assert.equal((await service.list(user2.id,undefined,marker)).posts.length,1,"friend can read friends-only post");
            assert.equal((await service.list(user3.id,undefined,marker)).posts.length,0,"stranger cannot read friends-only post");
            await service.update(user1.id,id,{...input(marker),privacy:"private",keepMediaIds:[BigInt(attachment.id)]},[]);
            assert.equal((await service.list(user2.id,undefined,marker)).posts.length,0,"friend cannot read private post");
            assert.equal((await service.list(user1.id,undefined,marker)).posts.length,1,"owner can read private post");
            await service.update(user1.id,id,input(marker+" replaced"),[file]);
            assert.ok(removed.includes("posts/1/1.png"),"replaced object cleaned");
            await tx.posts.createMany({data:Array.from({length:22},(_,i)=>({user_id:user1.id,content:marker+" page "+i,privacy:"public"}))});
            const page1=await service.list(user1.id,undefined,marker);assert.equal(page1.posts.length,20);assert.ok(page1.nextCursor);
            const page2=await service.list(user1.id,BigInt(page1.nextCursor),marker);assert.equal(page2.posts.length,3);assert.equal(page2.nextCursor,null);assert.ok(!page2.posts.some(post=>page1.posts.some(other=>other.id===post.id)));
            await service.remove(user1.id,id);
            assert.ok((await tx.posts.findUnique({where:{id}})).deleted_at);
            assert.equal(await tx.attachments.count({where:{owner_type:"post",owner_id:id}}),0);
            await assert.rejects(service.remove(user1.id,id),NotFoundException);
            throw rollback;
        },{timeout:120000}),error=>error===rollback);
        assert.equal(await prisma.users.count({where:{email:{startsWith:marker}}}),0,"test accounts rolled back");
    }finally{await prisma.$disconnect();}
});

test("real MinIO: private upload, signed GET and Range, cleanup only the test object", {skip:process.env.POSTS_MINIO_TESTS!=="1"}, async()=>{
    const storage=new PostStorageService();let key;
    try {
        const uploaded=await storage.upload(1n,file);key=uploaded.key;
        const url=await storage.url(key,"image/png");
        const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/png");assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
        const privateUrl=new URL(url);privateUrl.search="";assert.equal((await fetch(privateUrl)).status,403);
        const range=await fetch(url,{headers:{Range:"bytes=0-7"}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
        await storage.remove([key]);assert.equal((await fetch(url)).status,404);
    }finally{if(key)await storage.remove([key]);storage.onModuleDestroy?.();}
});

test("real database rejects media from another post and rolls back the mutation", {skip:process.env.POSTS_DB_TESTS!=="1"}, async()=>{
    const prisma=new PrismaService();const marker="posts-ownership-"+crypto.randomUUID();
    try{
        await assert.rejects(prisma.$transaction(async tx=>{
            const user=await tx.users.create({data:{email:marker+"@example.invalid",password_hash:"test-only"}});
            const first=await tx.posts.create({data:{user_id:user.id,content:"original"}});
            const second=await tx.posts.create({data:{user_id:user.id,content:"another post"}});
            const media=await tx.attachments.create({data:{owner_type:"post",owner_id:second.id,file_url:"posts/1/foreign.png",file_type:"image/png"}});
            const adapter=new Proxy(tx,{get(target,key){return key==="$transaction" ? callback=>callback(tx) : target[key];}});
            const service=new PostsService(adapter,{remove:async()=>{},upload:async()=>{throw Error("Unexpected upload");}});
            await service.update(user.id,first.id,{content:"changed",privacy:"public",keepMediaIds:[media.id]},[]);
        },{timeout:30000}),BadRequestException);
        assert.equal(await prisma.users.count({where:{email:marker+"@example.invalid"}}),0);
    }finally{await prisma.$disconnect();}
});
