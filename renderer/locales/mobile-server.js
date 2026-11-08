// スマホ用 API サーバー（src/mobile-server.js）の表示文。原文（日本語）がキー。
(typeof module === 'object' && module.exports ? require('../i18n.js') : I18n).add({
  "このメソッドは使えません": {"en":"This method is not allowed","es":"Este método no está permitido","fr":"Cette méthode n'est pas autorisée","zh":"不允许使用此方法"},
  "この操作はスマホからは使えません: {channel}": {"en":"This action is not available from a phone: {channel}","es":"Esta acción no está disponible desde el móvil: {channel}","fr":"Cette action n'est pas disponible depuis un téléphone : {channel}","zh":"不能从手机使用此操作：{channel}"},
  "スマートフォン": {"en":"Phone","es":"Móvil","fr":"Téléphone","zh":"手机"},
  "ペアリングコードが違うか、期限切れです。アプリで新しいコードを出してください": {"en":"The pairing code is wrong or has expired. Show a new code in the app.","es":"El código de emparejamiento es incorrecto o ha caducado. Muestre un código nuevo en la aplicación.","fr":"Le code d'appairage est incorrect ou a expiré. Affichez un nouveau code dans l'application.","zh":"配对代码不正确或已过期。请在应用中显示新的代码。"},
  "ペアリングコードが出ていません。アプリで新しいコードを出してください": {"en":"No pairing code is shown. Show a new code in the app.","es":"No hay ningún código de emparejamiento. Muestre un código nuevo en la aplicación.","fr":"Aucun code d'appairage n'est affiché. Affichez un nouveau code dans l'application.","zh":"当前没有配对代码。请在应用中显示新的代码。"},
  "リクエストの形が正しくありません": {"en":"The request is malformed","es":"La solicitud no tiene el formato correcto","fr":"La requête est mal formée","zh":"请求格式不正确"},
  "ログインしてください。アプリに出ているペアリングコードを入れてください": {"en":"Please sign in. Enter the pairing code shown in the app.","es":"Inicie sesión. Introduzca el código de emparejamiento que muestra la aplicación.","fr":"Veuillez vous connecter. Saisissez le code d'appairage affiché dans l'application.","zh":"请登录。请输入应用中显示的配对代码。"},
  "ログインの期限が切れました。もう一度ペアリングしてください": {"en":"Your sign-in has expired. Pair again.","es":"Su sesión ha caducado. Empareje de nuevo.","fr":"Votre connexion a expiré. Appairez à nouveau.","zh":"登录已过期。请重新配对。"},
  "試す回数が多すぎます。しばらく待ってから、もう一度試してください": {"en":"Too many attempts. Wait a moment and try again.","es":"Demasiados intentos. Espere un momento y vuelva a intentarlo.","fr":"Trop de tentatives. Patientez un moment, puis réessayez.","zh":"尝试次数过多。请稍候再试。"},
  "送られたデータが大きすぎます": {"en":"The data sent is too large","es":"Los datos enviados son demasiado grandes","fr":"Les données envoyées sont trop volumineuses","zh":"发送的数据太大"},
});
