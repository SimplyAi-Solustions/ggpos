/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_382976912")

  // update collection data
  unmarshal({
    "createRule": "@request.auth.collectionName = \"customers\""
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_382976912")

  // update collection data
  unmarshal({
    "createRule": "@request.auth.collectionName = \"staff\" || (@request.auth.collectionName = \"customers\" && quote.customer = @request.auth.id && customer = @request.auth.id && author_kind = \"customer\" && staff:isset = false)"
  }, collection)

  return app.save(collection)
})
