
//引入http模块
var socketio = require('socket.io'),
	fs 	= require('fs'),
	http     = require('http'),
	domain   = require('domain'),
	redis    = require('redis'),
    redisio  = require('socket.io-redis'),
    request  = require('request'),
    config   = require('./config.js'),
    log4js = require("log4js"),
    schedule = require('node-schedule');


var logConf = require("./logConf.json")
log4js.configure(logConf)
var logger = log4js.getLogger("default")


var os = require("os")
var d = domain.create();
d.on("error", function(err) {
	console.log(err);
});
// var options = {
//     key: fs.readFileSync('/usr/local/nginx/conf/ssl/livenewss.yunbaozhibo.com.key'),
//     cert: fs.readFileSync('/usr/local/nginx/conf/ssl/livenewss.yunbaozhibo.com.crt')
//   }; 
//var numscount=0;// 在线人数统计
//



//敏感词字典加载
var replaceChar = "*"
var filepath = config["sensitive_word_path"]
var data = fs.readFileSync(filepath)
var content = data.toString().split(os.EOL).join("|")
content = content.substr(0,content.length - 1)
var regex = new RegExp(content,"gi")
function sensitiveWordFilter(chatString){
	
    return chatString.replace(regex,"*") 
}
    
var sockets = {};
var chat_history={};
var chat_interval={};


// 定时清理消费金额
function scheduleClearConsume() {
    schedule.scheduleJob('* * 3 * * *', function () {
        // 获取房间列表
        var socket_stream_set = new Set()
        sockets.forEach(function (x) {
            socket_stream_set.add(x.stream)
        })
        // 清理REDIS用户列表的缓存数据
        socket_stream_set.forEach(function (x) {
            clientRedis.hgetall("userlist_"+x,function(err,res){
                for(var key in res){
                    var value = JSON.parse(res[key])
                    value['contribute'] = 0.0
                    clientRedis.hset("userlist_"+x,key, JSON.stringify(value))
                }

            })
        })
        //清理REDIS消费金额的缓存数据
        socket_stream_set.forEach(function (x) {
            clientRedis.del("consume_" + x)
        })

    });
}

scheduleClearConsume();

// redis 链接
var clientRedis  = redis.createClient(config['REDISPORT'],config['REDISHOST']);
clientRedis.auth(config['REDISPASS']);
var server = http.createServer(function(req, res) {
	res.writeHead(200, {
		'Content-type': 'text/html;charset=utf-8'
	});
   //res.write("人数: " + numscount );
	res.end();
}).listen(config['socket_port'], function() {
	//console.log('服务开启19965');
});

var io = socketio.listen(server,{
	pingTimeout: 60000,
  	pingInterval: 25000
});
/* var pub = redis.createClient(config['REDISPORT'], config['REDISHOST'], { auth_pass: config['REDISPASS'] });
 var sub = redis.createClient(config['REDISPORT'], config['REDISHOST'], { auth_pass: config['REDISPASS'] });
 io.adapter(redisio({ pubClient: pub, subClient: sub })); */
//setInterval(function(){
  //global.gc();
  //console.log('GC done')
//}, 1000*30); 

io.on('connection', function(socket) {
	//console.log('连接成功');
	//numscount++;
							
	var interval;

	//进入房间
	socket.on('conn', function(data) {
		
		if(!data || !data.token){
				return !1;
		}
		
		userid=data.uid;
		old_socket = sockets[userid];
		if (old_socket && old_socket != socket) {
			
			if(data.uid== data.roomnum && data.stream==old_socket.stream){
				old_socket.reusing = 1;
				//console.log("重用");
			}else if(data.uid== data.roomnum && data.stream!=old_socket.stream){
				var data_str='{"retmsg":"ok","retcode":"000000","msg":[{"msgtype":"1","_method_":"StartEndLive","action":"19","ct":"直播关闭"}]}';
				old_socket.emit('broadcastingListen',[data_str]);
			}
			old_socket.disconnect()
		}
		
		clientRedis.get(data.token,function(error,res){
			if(error){
				return;
			}else if(res==null){
				//console.log("[获取token失败]"+data.uid);
			}else{
				if(res != null){
					
					var userInfo = evalJson(res);
					if(userInfo['id'] == data.uid ){
						//console.log("[初始化验证成功]--"+data.uid+"---"+data.roomnum+'---'+data.stream);
						//获取验证token
						socket.token   = data.token; 
						socket.sign    = userInfo['sign'];
						socket.roomnum = data.roomnum;
						socket.stream = data.stream;
						socket.nicename = userInfo['user_nicename'];
						socket.uType   = parseInt(userInfo['userType']);
						socket.uid     = data.uid;
						socket.reusing = 0;
						
						socket.join(data.roomnum);
						sockets[userid] = socket;
						socket.emit('conn',['ok']);
						if( socket.roomnum!=socket.uid && socket.uid >0 ){
							console.log(userInfo['vip']['type']);
							var data_str="{\"msg\":[{\"_method_\":\"SendMsg\",\"action\":\"0\",\"ct\":{\"id\":\""+userInfo['id']+"\",\"user_nicename\":\""+userInfo['user_nicename']+"\",\"avatar\":\""+userInfo['avatar']+"\",\"avatar_thumb\":\""+userInfo['avatar_thumb']+"\",\"level\":\""+userInfo['level']+"\",\"vip_type\":\""+userInfo['vip']['type']+"\",\"car_id\":\""+userInfo['car']['id']+"\",\"car_swf\":\""+userInfo['car']['swf']+"\",\"car_swftime\":\""+userInfo['car']['swftime']+"\",\"car_words\":\""+userInfo['car']['words']+"\"},\"msgtype\":\"0\"}],\"retcode\":\"000000\",\"retmsg\":\"OK\"}";
							process_msg(io,socket.roomnum,data_str);


							if(socket.stream){
                                // 初始化消费
                                clientRedis.hget('consume_' + socket.stream, socket.sign, function (err,res){
                                    if(!res){
                                        clientRedis.hget("consume_" +socket.stream, socket.sign, 0.0)
                                    }
                                    userInfo['contribute'] = clientRedis.hget("consume_" +socket.stream, socket.sign)
                                })

                                res = JSON.stringify(userInfo)
                                clientRedis.hset('userlist_' + socket.stream, socket.sign, res);
								clientRedis.hset('userlist_'+socket.stream,socket.sign,res);	
							}
						}						
						 
						sendSystemMsg(socket,"直播内容包含任何低俗、暴露和涉黄内容，账号会被封禁；安全部门会24小时巡查哦～");
						return;
					}else{
						socket.disconnect();
					}
				}
			}
			
			socket.emit('conn',['no']);
		});
        
		
	});

	socket.on('broadcast',function(data){
            //console.log(data);
		    if(socket.token != undefined){
		        logger.info("socket data")
                logger.info("\n" + data)
		    	var dataObj  = typeof data == 'object'?data:evalJson(data);
			    var msg      = dataObj['msg'][0]; 
			    var token    = dataObj['token'];
				var method   = msg['_method_'];
			    var action   = msg['action'];
			    var data_str =  typeof data == 'object'?JSON.stringify(data):data;
			    switch(method){
			    	case 'SendMsg':{     //聊天

			    		console.log("SendMsg");
					console.log("route 1");
						clientRedis.hget( "super",socket.uid,function(error,res){
							console.log("route 2")
							if(error) return;
							console.log("route 3")
							if(res != null){
								var data_str2='{"msg":[{"_method_":"SystemNot","action":"1","ct":"'+ dataObj['msg'][0]['ct'] +'","msgtype":"4"}],"retcode":"000000","retmsg":"OK"}';
								process_msg(io,socket.roomnum,data_str2);
		    				}else{
								
							console.log("other route 3");
								clientRedis.hget(socket.roomnum + "shutup",socket.uid,function(error,res){
									if(error) return;
									if(res != null){
										var time = Date.parse(new Date())/1000;

										if((time < parseInt(res))){
											
											var newData  = dataObj;
											
											socket.emit('broadcastingListen',[JSON.stringify(newData)]);
										}else{//解除禁言
											clientRedis.hdel(socket.roomnum + "shutup",socket.uid);
											process_msg(io,socket.roomnum,data_str);
										}										
									}else{
										var data_str_obj = JSON.parse(data_str)
										data_str_obj["msg"][0]["ct"] = sensitiveWordFilter(data_str_obj["msg"][0]["ct"])
										process_msg(io,socket.roomnum,JSON.stringify(data_str_obj));
									}	
								});
		    				}							
						});
			    		break;
			    	}
			    	case 'SendGift':{    //送礼物
						var gifToken = dataObj['msg'][0]['ct'];
			    		clientRedis.get(gifToken,function(error,res){
			    			if(!error&&res != null){
			    				var resObj = evalJson(res);
			    				dataObj['msg'][0]['ct'] = resObj;
								io.sockets.in(socket.roomnum).emit('broadcastingListen',[JSON.stringify(dataObj)]);
			    				clientRedis.del(gifToken);
			    			}
			    		});
			    		break;
			    	}
						
					case 'SendBarrage':{    //弹幕
						var barragetoken = dataObj['msg'][0]['ct'];
			    		clientRedis.get(barragetoken,function(error,res){
			    			if(!error&&res != null){
			    				var resObj = evalJson(res);
			    				dataObj['msg'][0]['ct'] = resObj;
								var data_str=JSON.stringify(dataObj);
								process_msg(io,socket.roomnum,data_str);
			    				clientRedis.del(barragetoken);
			    			}	
			    		});
			    		break;
			    	}
			    	case 'SendFly' :{    //飞屏
			    		clientRedis.get(socket.uid + 'SendFly',function(error,res){
			    			if(!error&&res == '1'){
								process_msg(io,socket.roomnum,data_str);
			    				clientRedis.del(socket.uid + 'SendFly');
			    			}else{

			    			}
			    		});
	                    break;
			    	}
			    	case 'fetch_sofa' :{ //抢座
			    		clientRedis.get(socket.uid + 'fetch_sofa',function(error,res){
			    			if(!error&&res == '1'){
								process_msg(io,socket.roomnum,data_str);
			    				clientRedis.del(socket.uid + 'fetch_sofa');
			    			}else{

			    			}
			    			
			    		});
	                    break;
			    	}
					case 'ConnectVideo' :{ //连麦
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
					case 'CloseVideo' :{ //下麦
						clientRedis.hget('ShowVideo',socket.roomnum,function(error,res){
							if(!error && (socket.uid==res || socket.uid==socket.roomnum) ){
								clientRedis.hdel('ShowVideo',socket.roomnum);
								process_msg(io,socket.roomnum,data_str);									
							}							 
						});
							
	                    break;
			    	}
					case 'ShowVideo' :{ //上麦显示
						clientRedis.hget('ShowVideo',socket.roomnum,function(error,res){
							if(!error && socket.uid==res){
								process_msg(io,socket.roomnum,data_str);									
							}							 
						});
	                    break;
			    	}
			    	case 'SendTietiao' :{ //贴条
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
			    	case 'SendHb' :{      //送红包
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
			    	case 'VodSong' :{     //点歌
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
					case 'light' :{     //点亮
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
					case 'changeLive' :{//切换房间收费
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
					case 'updateVotes' :{//更新映票
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
			    	case 'SetBackground' :{//设置背景
			    		if(socket.uType == 50){
							process_msg(io,socket.roomnum,data_str);
			    		}
	                    break;
			    	}
			    	case 'CancelBackground' :{//取消背景
			    		if(socket.uType == 50){
							process_msg(io,socket.roomnum,data_str);
			    	    }
	                    break;
			    	}
			    	case 'AgreeSong' :{//同意点歌
			    		if(socket.uType == 50){
							process_msg(io,socket.roomnum,data_str);
			    	    }
	                    break;
			    	}
			    	case 'SubmitBroadcast' :{//广播
			    		clientRedis.get(socket.uid + 'SubmitBroadcast',function(error,res){
			    			if(!error&&res == '1'){
								process_msg(io,socket.roomnum,data_str);
			    				clientRedis.del(socket.uid + 'SubmitBroadcast');
			    			}
			    		});
	                    break;
			    	}
			    	case 'MoveRoom' :{//转移房间
			    		if(socket.uType == 50 || socket.uType == 40){
							process_msg(io,socket.roomnum,data_str);
			    	    }
	                    break;
			    	}
			    	case 'SetchatPublic' :{//开启关闭公聊
			    		if(socket.uType == 50 || socket.uType == 40){
							process_msg(io,socket.roomnum,data_str);
						}
	                    break;
			    	}
			    	case 'CloseLive' :{//关闭直播
			    		console.log("CloseLive===================>");
			    		console.log(socket.uType);
			    		if(socket.uType == 50 || socket.uType == 40){
							process_msg(io,socket.roomnum,data_str);
			    	    }
	                    break;
			    	}
			    	case 'SetBulletin' :{//房间公告
	                    if(socket.uType == 50 || socket.uType == 40){
							process_msg(io,socket.roomnum,data_str);
			    		}
	                    break;
			    	}
			    	case 'NoticeMsg' :{//全站礼物
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
			    	case 'KickUser' :{//踢人
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
			    	case 'ShutUpUser' :{//禁言
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
					case 'stopLive' :{//超管关播
						clientRedis.hget( "super",socket.uid,function(error,res){
							if(error) return;
							if(res != null){
								process_msg(io,socket.roomnum,'stopplay');								
		    				}							
						});
						break;
			    	}
			    	case 'SendPrvMsg' :{//私聊
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
			    	case 'ResumeUser' :{//恢复发言
			    		if(socket.uType == 50 || socket.uType == 40){
							process_msg(io,socket.roomnum,data_str);
			    	    }
			    	    break;
			    	} 
			    	case 'StartEndLive':{
			    		console.log("socket.uType===================>");
			    		console.log(socket.uType);
			    		if(socket.uType == 50 ){
			    		   socket.broadcast.to(socket.roomnum).emit('broadcastingListen',[data_str]);
			    	    }else{
			    	    	clientRedis.get("LiveAuthority" + socket.uid,function(error,res){
			    	    		if(error) return;
			    	    		if(parseInt(res) == 5 ||parseInt(res) == 1 || parseInt(res) == 2){
		    	    				socket.broadcast.to(socket.roomnum).emit('broadcastingListen',[data_str]);
		    	    			}
			    	    	})
			    	    }
			    	    break;

			    	}
			    	case 'RowMike':{//排麦
						process_msg(io,socket.roomnum,data_str);
			    		break;
			    	}
			    	case 'OpenGuard':{//购买守护
						process_msg(io,socket.roomnum,data_str);
			    		break;
			    	}
			    	case 'SystemNot':{//系统通知
						process_msg(io,socket.roomnum,data_str);
			    		break;
			    	}
                    case 'shangzhuang' :{//上、下庄
						process_msg(io,socket.roomnum,data_str);
	                    break;
			    	}
					case 'auction':{//竞拍 
						if(action==1){
							var auctionid=msg['auctionid'];
							request(config['WEBADDRESS']+"?service=Live.getAuction&id="+auctionid,function(error, response, body){
								if(error) return;
								if(!body) return;
								var res = evalJson(body);
								if(res.ret==200 && res.data.code==0){
									var resObj = res.data.info[0];
									dataObj['msg'][0]['ct'] = resObj;
									var data_str2=JSON.stringify(dataObj);
									//console.log(data_str2);
									process_msg(io,socket.roomnum,data_str2);
								}
							});
						}else{
							process_msg(io,socket.roomnum,data_str);
						}

			    		break;
			    	}
					case 'startGame':{//炸金花游戏
						process_msg(io,socket.roomnum,data_str);
						if(action==4)
						{
							var time=msg['time']*1000;
							var gameid=msg['gameid'];
							setTimeout(function() {//定时发送结果
								// var token   = msg['token'];
								// clientRedis.get(token+"_Game",function(error,res){
									// if(!error&&res != null){
										// var resObj = JSON.parse(res);
										// dataObj['msg'][0]['ct'] = resObj;
										// dataObj['msg'][0]['_method_'] = "startGame";
										// dataObj['msg'][0]['action']="6";
										// var data_str2=JSON.stringify(dataObj);
										
										request(config['WEBADDRESS']+"?service=Game.endGame&liveuid="+socket.uid + "&token=" + socket.token+ "&gameid=" + gameid+"&type=1",function(error, response, body){
											if(error) return;
											var res = evalJson(body);
											if( response.statusCode == 200 && res.data.code == 0){
												var resObj = res.data.info;
												dataObj['msg'][0]['ct'] = resObj;
												dataObj['msg'][0]['_method_'] = "startGame";
												dataObj['msg'][0]['action']="6";
												var data_str2=JSON.stringify(dataObj);
												process_msg(io,socket.roomnum,data_str2);
											}
										});
									// }	
								// });
							}, time);
						}
						break;
					}
					case 'startRotationGame':{//转盘
						process_msg(io,socket.roomnum,data_str);
						if(action==4)
						{
							var time=msg['time']*1000;
							var gameid=msg['gameid'];
							setTimeout(function() {//定时发送结果
								// var token   = msg['token'];
								// clientRedis.get(token+"_Game",function(error,res){
									// if(!error&&res != null){
										// var resObj = JSON.parse(res);
										// dataObj['msg'][0]['ct'] = resObj;
										// dataObj['msg'][0]['_method_'] = "startRotationGame";
										// dataObj['msg'][0]['action']="6";
										// var data_str2=JSON.stringify(dataObj);
										
										request(config['WEBADDRESS']+"?service=Game.endGame&liveuid="+socket.uid + "&token=" + socket.token+ "&gameid=" + gameid+"&type=1",function(error, response, body){
											if(error) return;
											//console.log(body);
											var res = evalJson(body);
															
											if( response.statusCode == 200 && res.data.code == 0){
												var resObj = res.data.info;
												dataObj['msg'][0]['ct'] = resObj;
												dataObj['msg'][0]['_method_'] = "startRotationGame";
												dataObj['msg'][0]['action']="6";
												var data_str2=JSON.stringify(dataObj);
												process_msg(io,socket.roomnum,data_str2);
											}
										});
									// }	
								// });
							}, time);
						}
						break;
					}
					case 'startCattleGame':{//开心牛仔
						process_msg(io,socket.roomnum,data_str);
						if(action==4)
						{
							var time=msg['time']*1000;
							var gameid=msg['gameid'];
							setTimeout(function() {//定时发送结果
								// var token   = msg['token'];
								// clientRedis.get(token+"_Game",function(error,res){
									// if(!error&&res != null){
										// var resObj = JSON.parse(res);
										// dataObj['msg'][0]['ct'] = resObj;
										// dataObj['msg'][0]['_method_'] = "startCattleGame";
										// dataObj['msg'][0]['action']="6";
										// var data_str2=JSON.stringify(dataObj);

										request(config['WEBADDRESS']+"?service=Game.endGame&liveuid="+socket.uid + "&token=" + socket.token+ "&gameid=" + gameid+"&type=1",function(error, response, body){
											if(error) return;
											var res = evalJson(body);

											if( response.statusCode == 200 && res.data.code == 0){
												var resObj = res.data.info;
												dataObj['msg'][0]['ct'] = resObj;
												dataObj['msg'][0]['_method_'] = "startCattleGame";
												dataObj['msg'][0]['action']="6";
												var data_str2=JSON.stringify(dataObj);
												process_msg(io,socket.roomnum,data_str2);
											}
										});
									// }	
								// });
							}, time);
						}
						break;
					}
					case 'startLodumaniGame':{//海盗船长
						process_msg(io,socket.roomnum,data_str);
						if(action==4)
						{
							var time=msg['time']*1000;
							var gameid=msg['gameid'];
							setTimeout(function() {//定时发送结果
								// var token   = msg['token'];
								// clientRedis.get(token+"_Game",function(error,res){
									// if(!error&&res != null){
										// var resObj = JSON.parse(res);
										// dataObj['msg'][0]['ct'] = resObj;
										// dataObj['msg'][0]['_method_'] = "startLodumaniGame";
										// dataObj['msg'][0]['action']="6";
										// var data_str2=JSON.stringify(dataObj);

										request(config['WEBADDRESS']+"?service=Game.endGame&liveuid="+socket.uid + "&token=" + socket.token+ "&gameid=" + gameid+"&type=1",function(error, response, body){
											if(error) return;
											var res = evalJson(body);
											
											if( response.statusCode == 200 && res.data.code == 0){
												var resObj = res.data.info;
												dataObj['msg'][0]['ct'] = resObj;
												dataObj['msg'][0]['_method_'] = "startLodumaniGame";
												dataObj['msg'][0]['action']="6";
												var data_str2=JSON.stringify(dataObj);
												process_msg(io,socket.roomnum,data_str2);
											}
										});
									// }	
								// });
							}, time);
						}
						break;
					}
					case 'startShellGame':{//二八贝
						process_msg(io,socket.roomnum,data_str);
						if(action==4)
						{
							var time=msg['time']*1000;
							var gameid=msg['gameid'];
							setTimeout(function() {//定时发送结果
								// var token   = msg['token'];
								// clientRedis.get(token+"_Game",function(error,res){
									// if(!error&&res != null){
										// var resObj = JSON.parse(res);
										// dataObj['msg'][0]['ct'] = resObj;
										// dataObj['msg'][0]['_method_'] = "startShellGame";
										// dataObj['msg'][0]['action']="6";
										// var data_str2=JSON.stringify(dataObj);
	
										request(config['WEBADDRESS']+"?service=Game.endGame&liveuid="+socket.uid + "&token=" + socket.token+ "&gameid=" + gameid+"&type=1",function(error, response, body){
											if(error) return;
											var res = evalJson(body);
											if( response.statusCode == 200 && res.data.code == 0){
												var resObj = res.data.info;
												dataObj['msg'][0]['ct'] = resObj;
												dataObj['msg'][0]['_method_'] = "startShellGame";
												dataObj['msg'][0]['action']="6";
												var data_str2=JSON.stringify(dataObj);
												process_msg(io,socket.roomnum,data_str2);
											}
										});
									// }	
								// });
							}, time);
						}
						break;
					}
			    	case 'requestFans':{

							request(config['WEBADDRESS']+"?service=Live.getZombie&stream=" + socket.stream+"&uid=" + socket.uid,function(error, response, body){
								if(error) return;
								var res = evalJson(body);
								if( response.statusCode == 200 && res.data.code == 0){
									var data_str2="{\"msg\":[{\"_method_\":\"requestFans\",\"action\":\"3\",\"ct\": "+ body + ",\"msgtype\":\"0\"}],\"retcode\":\"000000\",\"retmsg\":\"OK\"}";
									process_msg(io,socket.roomnum,data_str2);
								}
							});

			    	}
						
			    }
		    }
		    
	});
	
	socket.on('superadminaction',function(data){
    	if(data['token'] == config['TOKEN']){
			process_msg(io,data['roomnum'],'stopplay');
    	}
    });
	/* 系统信息 */
	socket.on('systemadmin',function(data){
    	if(data['token'] == config['TOKEN']){
    		io.emit('broadcastingListen',['{"msg":[{"_method_":"SystemNot","action":"1","ct":"'+ data.content +'","msgtype":"4"}],"retcode":"000000","retmsg":"OK"}']);
    	}
    });
	
    //资源释放
	socket.on('disconnect', function() { 
			/* numscount--; 
            if(numscount<0){
				numscount=0;
			}   */
          			
			if(socket.roomnum ==null || socket.token==null){
				return !1;
			}
				
			d.run(function() {
				/* 连麦 */
				/* clientRedis.hget('ShowVideo',socket.roomnum,function(error,res){
					if(!error && (socket.uid==res || socket.uid==socket.roomnum) ){
						clientRedis.hdel('ShowVideo',socket.roomnum);		
						var data_str="{\"msg\":[{\"_method_\":\"CloseVideo\",\"action\":\"0\",\"msgtype\":\"20\",\"uid\":\""+socket.uid+"\",\"uname\":\""+socket.nicename+"\"}],\"retcode\":\"000000\",\"retmsg\":\"OK\"}";
						process_msg(io,socket.roomnum,data_str);
					}							 
				}); */
				
				
				if(socket.roomnum==socket.uid){

					console.log("主播");
					/* 主播 */ 
					if(socket.reusing==0){
						request(config['WEBADDRESS']+"?service=Live.stopRoom&uid="+socket.uid + "&token=" + socket.token+ "&stream=" + socket.stream,function(error, response, body){});
						var data_str='{"retmsg":"ok","retcode":"000000","msg":[{"msgtype":"1","_method_":"StartEndLive","action":"18","ct":"直播关闭"}]}';
						process_msg(io,socket.roomnum,data_str);
					}
				}else{


					console.log("dfdfdfdfsadf");
					/* 观众 */
					clientRedis.hget('userlist_'+socket.stream,socket.sign,function(error,res){
						if(error) return;
						if(res != null){
							var user = JSON.parse(res);
							var data_str="{\"msg\":[{\"_method_\":\"disconnect\",\"action\":\"1\",\"ct\":{\"id\":\""+user['id']+"\",\"user_nicename\":\""+user['user_nicename']+"\",\"avatar\":\""+user['avatar']+"\",\"level\":\""+user['level']+"\"},\"msgtype\":\"0\",\"uid\":\""+socket.uid+"\",\"uname\":\""+user.user_nicename+"\"}],\"retcode\":\"000000\",\"retmsg\":\"OK\"}";
							process_msg(io,socket.roomnum,data_str);	
						}
						clientRedis.hdel('userlist_'+socket.stream,socket.sign);
					});
					
				}
				//console.log(socket.roomnum+"==="+socket.token+"===="+socket.uid+"======"+socket.stream);
				
				socket.leave(socket.roomnum);
				delete io.sockets.sockets[socket.id];
				sockets[socket.uid] = null;
				delete sockets[socket.uid];

			});
	});

});
function sendSystemMsg(socket,msg){
	socket.emit('broadcastingListen',["{\"msg\":[{\"_method_\":\"SystemNot\",\"action\":\"1\",\"ct\":\""+ msg +"\",\"msgtype\":\"4\"}],\"retcode\":\"000000\",\"retmsg\":\"OK\"}"]);
						
}
function evalJson(data){
	return eval("("+data+")");
}

function process_msg(io,roomnum,data){
	if(!chat_history[roomnum]){
		chat_history[roomnum]=[];
	}
	chat_history[roomnum].push(data);
	chat_interval[roomnum] || (chat_interval[roomnum]=setInterval(function(){
		if(chat_history[roomnum].length>0){
			send_msg(io,roomnum);
		}else{
			clearInterval(chat_interval[roomnum]);
			chat_interval[roomnum]=null;
		}
	},200));
}

function send_msg(io,roomnum){
	var data=chat_history[roomnum].splice(0,chat_history[roomnum].length);
    io.sockets.in(roomnum).emit("broadcastingListen", data);
}

//时间格式化
function FormatNowDate(){
	var mDate = new Date();
	var H = mDate.getHours();
	var i = mDate.getMinutes();
	var s = mDate.getSeconds();
	return H + ':' + i + ':' + s;
}
