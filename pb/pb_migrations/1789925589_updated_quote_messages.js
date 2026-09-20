/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_382976912")

  // update collection data
  unmarshal({
    "createRule": "@request.auth.collectionName = \"customers\" && customer = @request.auth.id"
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_382976912")

  // update collection data
  unmarshal({
    "createRule": "@request.auth.collectionName = \"customers\""
  }, collection)

  return app.save(collection)
})
