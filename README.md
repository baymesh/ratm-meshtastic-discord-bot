# Rage Against The Mesh(ine)
a discord bot for meshtastic

There is a Dockerfile, you can deploy this anywhere that you can run docker containers?

## Enviroment Variables

`DISCORD_WEBHOOK_URL`: discord webhook url for where to send Bay Mesh messages
`SV_DISCORD_WEBHOOK_URL`: discord webhook url for where to send Sac Valley mesh messages
`REDIS_ENABLED`: if `true` it we cache in redis, you need to specify the url (see next item)
`REDIS_URL`: redis url (with user/pass etc) if you want to have persistent nodeDB
`GROUPING_DURATION`: how long the logger will wait for packets for a new message that it sees
`PFP_JSON_URL`: json file that links node ids to profile images, example [here](https://raw.githubusercontent.com/baymesh/bot_pfp/refs/heads/main/baymesh_pfp.json)
