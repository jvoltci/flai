(window.webpackJsonp=window.webpackJsonp||[]).push([[0],{14:function(e,t,n){e.exports=n(26)},20:function(e,t,n){},21:function(e,t,n){},22:function(e,t,n){},26:function(e,t,n){"use strict";n.r(t);var a=n(0),r=n.n(a),o=n(12),l=n.n(o),c=(n(20),n(5)),i=n(6),u=n(9),s=n(7),m=n(10),p=(n(21),function(e){var t=e.items;return r.a.createElement("ul",null,t.map(function(e){return r.a.createElement("li",null,r.a.createElement("a",{className:"link",href:"https://flai-api.heroku.com/torrent/"+e},e))}))}),d=function(e){function t(){var e;return Object(c.a)(this,t),(e=Object(u.a)(this,Object(s.a)(t).call(this))).changeExtension=function(t){e.setState({extension:t.target.value})},e.changeURL=function(t){e.setState({url:t.target.value})},e.changePassword=function(t){e.setState({password:t.target.value})},e.handleTorrent=function(){fetch("https://flai-api.herokuapp.com/metadata",{method:"POST",body:JSON.stringify({url:e.state.url,password:e.state.password}),headers:{"Content-Type":"application/json"}}).then(function(t){e.setState({files:t,list:1})})},e.state={extension:"",list:0,files:[],url:"",password:""},e}return Object(m.a)(t,e),Object(i.a)(t,[{key:"componentDidUpdate",value:function(){"magnet"===this.state.extension&&this.handleTorrent()}},{key:"render",value:function(){var e=this;return r.a.createElement("div",{id:"home",className:"container"},r.a.createElement("h3",{id:"u1"},"Welcome To fl",r.a.createElement("span",{id:"u11"},"ai")," Downloads"),r.a.createElement("div",{className:"row"},this.state.list?r.a.createElement(p,{items:this.state.files}):"",r.a.createElement("div",{className:"col-12",align:"center"},r.a.createElement("form",{onSubmit:function(t){return"magnet"===e.state.extension?t.preventDefault():""},method:"post",action:"https://flai-api.heroku.com/download"},r.a.createElement("div",{className:"form-group"},r.a.createElement("input",{onChange:function(t){return e.changeURL(t)},type:"text",name:"user[url]",required:!0,className:"form-control",placeholder:"Downloadable URL | Magnet URI",id:"u2"}),r.a.createElement("input",{onChange:function(t){return e.changePassword(t)},type:"password",name:"user[password]",required:!0,className:"form-control",placeholder:"Password",id:"u3"}),r.a.createElement("input",{onChange:function(t){return e.changeExtension(t)},list:"extension",name:"user[extension]",required:!0,className:"extension",placeholder:"Extension",id:"u4"}),r.a.createElement("datalist",{id:"extension"},r.a.createElement("option",{value:".zip"},".zip"),r.a.createElement("option",{value:".mp4"},".mp4"),r.a.createElement("option",{value:".mkv"},".mkv"),r.a.createElement("option",{value:".mp3"},".mp3"),r.a.createElement("option",{value:".exe"},".exe"),r.a.createElement("option",{value:"magnet"},"magnet")),r.a.createElement("button",{type:"submit",className:"btn btn-danger"},"Download"))))))}}]),t}(a.Component),h=n(28),f=n(29),E=n(30),g=(n(22),function(e){function t(){var e,n;Object(c.a)(this,t);for(var a=arguments.length,r=new Array(a),o=0;o<a;o++)r[o]=arguments[o];return(n=Object(u.a)(this,(e=Object(s.a)(t)).call.apply(e,[this].concat(r)))).trigger=function(){document.querySelector("#u2").value="",document.querySelector("#u3").value="",document.querySelector("#u4").value=""},n}return Object(m.a)(t,e),Object(i.a)(t,[{key:"render",value:function(){var e=this;return r.a.createElement(h.a,null,r.a.createElement(f.a,null,r.a.createElement(E.a,{path:"/",component:function(){return r.a.createElement(d,{trigger:e.trigger})},exact:!0}),r.a.createElement(E.a,{component:function(){return r.a.createElement("h1",{style:{textAlign:"center",paddingTop:"40vh"}},"Error 404: Not Found!")}})))}}]),t}(a.Component));l.a.render(r.a.createElement(g,null),document.getElementById("root"))}},[[14,1,2]]]);
//# sourceMappingURL=main.b4f77266.chunk.js.map