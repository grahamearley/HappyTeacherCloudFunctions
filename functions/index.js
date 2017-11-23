const functions = require('firebase-functions');
const admin = require('firebase-admin');
const gcs = require('@google-cloud/storage')();
admin.initializeApp(functions.config().firebase);

exports.setResourceTimeUpdated = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onWrite(event => {
        if (!event.data.exists) {
            return null;
        }

        const now = new Date();
        const previousDateUpdated = event.data.data().dateUpdated;

        if (previousDateUpdated) {
            // Calculate difference between the dates
            const timeDiffMillis = now - previousDateUpdated;
            const timeDiffMinutes = timeDiffMillis / 60000;

            // If the updated time is within 5 minutes, don't update
            //  (this is to prevent this function from triggering infinitely)
            if (Math.abs(timeDiffMinutes) < 5) {
                return null;
            }
        }

        return event.data.ref.update({dateUpdated: now});
    });

/**
 * When a lesson is written with `isFeatured` set to true,
 *  ensure that no other lesson has `isFeatured` set to true.
 */
exports.ensureExactlyOneLessonIsFeatured = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onWrite(event => {
        if (!event.data.exists) {
            return null;
        }

        const resourceRef = event.data.ref;
        const type = event.data.data().resourceType;
        const isFeatured = event.data.data().isFeatured;

        if (type !== "lesson") {
            return null;
        }

        const subtopic = event.data.data()["subtopic"];

        const resourceCollectionRef = event.data.ref.parent;
        const featuredLessonsForSubtopicQuery = resourceCollectionRef.where("subtopic", "==", subtopic)
            .where("resourceType", "==", "lesson")
            .where("status", "==", "published")
            .where("isFeatured", "==", true);

        return featuredLessonsForSubtopicQuery.get().then(function(querySnapshot) {
            const writePromises = [];

            if (isFeatured) {
                // Unfeature any other featured lessons
                querySnapshot.forEach(function (doc) {

                    // Ensure we're not writing to the ref that triggered this function
                    if (doc.ref.path !== resourceRef.path) {
                        let unfeaturePromise = doc.ref.update({isFeatured: false});
                        writePromises.push(unfeaturePromise);
                    }

                });
            } else if (querySnapshot.empty) {
                // There are no featured lessons, so set this lesson as featured.
                const featurePromise = resourceRef.update({isFeatured: true});
                writePromises.push(featurePromise);
            }

            return Promise.all(writePromises);
        });

    });

exports.countSubtopicLessonSubmissions = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
	.onWrite(event => {
        let subtopic = null;

        // Ensure the resource is/was a lesson:
        if ((event.data.exists && event.data.data()["resourceType"] !== "lesson")
            || (event.data.previous && event.data.previous.data()["resourceType"]) !== "lesson") {
            return null;
        }

        // Begin by setting subtopic to be the old subtopic, if possible:
	    if (event.data.previous && event.data.previous.data()["subtopic"]) {
	        subtopic = event.data.previous.data()["subtopic"]
        }

        // If there's a new subtopic (and the data hasn't been deleted), use that:
        if (event.data.exists && event.data.data()["subtopic"]) {
            subtopic = event.data.data()["subtopic"];
        }

        // If neither the old nor new data has a subtopic, cancel the operation.
        if (!subtopic) {
	        return null;
        }

	    const resourceCollectionRef = event.data.ref.parent;
        const lessonsForSubtopicQuery = resourceCollectionRef.where("subtopic", "==", subtopic)
                                                            .where("resourceType", "==", "lesson")
                                                            .where("status", "==", "published");


        return lessonsForSubtopicQuery.get().then(function(querySnapshot) {
            const count = querySnapshot.size;

            const featuredLessonsForSubtopicQuery = lessonsForSubtopicQuery.where("isFeatured", "==", true);

            const writePromises = [];
            featuredLessonsForSubtopicQuery.get().then(function(querySnapshot) {

                querySnapshot.forEach(function(doc) {
                    let writePromise = doc.ref.update({subtopicSubmissionCount : count});
                    writePromises.push(writePromise);
                });

                // Write count to all featured lessons (there should only be one)
                return Promise.all(writePromises);
            });
        });
	});

/**
 * A function for creating a convenience field so we can simulate performing a query
 *  with logical OR -- we want to know if this lesson is either awaiting review or has
 *  changes requested.
 */
exports.checkIfIsAwaitingReviewOrHasChangesRequested = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onWrite(event => {
        if (!event.data.exists) {
            return null;
        }

        const status = event.data.data().status;
        if (!status) {
            return null;
        }

        const isAwaitingReview = status === "awaiting review";
        const hasChangesRequested = status === "changes requested";

        const isAwaitingReviewOrHasChangesRequested = isAwaitingReview || hasChangesRequested;

        return event.data.ref.update("isAwaitingReviewOrHasChangesRequested", isAwaitingReviewOrHasChangesRequested);
    });

exports.addAttachmentMetadataToCard = functions.firestore.document('localized/{languageCode}/resources/{resourceId}/cards/{cardId}')
	.onUpdate(event => {

	    const attachmentPath = event.data.data().attachmentPath;

	    if (!attachmentPath) {
	        return null;
        }

		const bucketName = functions.config().firebase.storageBucket;
		const file = gcs.bucket(bucketName).file(attachmentPath);

		return file.getMetadata().then(function(data) {

			metadataObject = {
				"contentType": data[0]["contentType"],
				"size": Number(data[0]["size"]),
				"timeCreated": Date.parse(data[0]["timeCreated"])
			};

            return event.data.ref.update({
                attachmentMetadata: metadataObject
            });
		});
	});

// TODO: remove!
exports.deleteDraftCardAttachmentsFromStorage = functions.firestore.document('users/{userId}/drafts/{parentContentId}/cards/{cardId}')
    .onDelete(event => {
        const userId = event.params.userId;
        const cardId = event.params.cardId;
        const parentContentId = event.params.parentContentId;

        return deleteAttachmentFilesForCard(userId, parentContentId, cardId);
    });

/**
 * This function deletes card attachments from storage when an individual
 *  card is deleted and the parent resource *still exists*.
 *
 *  However, when the parent resource of a card is deleted, the cards will
 *  be deleted (by {@link deleteCardsAndAttachmentsWithResource}). In this case, we
 *  can't access the "authorId" field (since the parent resource is missing).
 *
 *  Thus, attachment deletion is also handled when an entire lesson is deleted
 *   in {@link deleteCardsAndAttachmentsWithResource}.
 */
exports.deleteCardAttachmentsFromStorage = functions.firestore.document('localized/{languageCode}/resources/{resourceId}/cards/{cardId}')
    .onDelete(event => {

        const resourceId = event.params.resourceId;
        const cardId = event.params.cardId;

        const resourceRef = event.data.ref.parent.parent;
        return resourceRef.get().then(function(documentSnapshot) {

            if (documentSnapshot.exists && documentSnapshot.data.exists) {
                const authorId = documentSnapshot.data["authorId"];
                return deleteAttachmentFilesForCard(authorId, resourceId, cardId);
            } else {
                // Parent content was deleted.
                return null;
            }
        });

    });

/**
 * {@see deleteCardAttachmentsFromStorage}
 */
exports.deleteCardsAndAttachmentsWithResource = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onDelete(event => {
        const resourceRef = event.data.ref;
        const cardsRef = resourceRef.collection('cards');

        const authorId = event.data.previous.data().authorId;
        const resourceId = event.params.resourceId;

        return cardsRef.get().then(querySnapshot => {
            const deletePromises = [];
            querySnapshot.forEach(documentSnapshot => {
                const cardId = documentSnapshot.id;

                // Delete card attachments:
                const deleteCardAttachmentsPromise =  deleteAttachmentFilesForCard(authorId, resourceId, cardId);
                deletePromises.push(deleteCardAttachmentsPromise);

                // Delete the card itself:
                const deleteCardPromise = documentSnapshot.ref.delete();
                deletePromises.push(deleteCardPromise);
            });
            return Promise.all(deletePromises);
        });
    });

function deleteAttachmentFilesForCard(userId, parentContentId, cardId) {
    const bucketName = functions.config().firebase.storageBucket;
    const bucket = gcs.bucket(bucketName);

    const attachmentsDirectory = `user_uploads/${userId}/${parentContentId}/${cardId}/`;

    return bucket.deleteFiles({ prefix: attachmentsDirectory });
}

// TODO: remove!
exports.deleteCardsWithDraft = functions.firestore.document('users/{userId}/drafts/{draftId}')
    .onDelete(event => {
        const draftRef = event.data.ref;
        const cardsRef = draftRef.collection('cards');

        return cardsRef.get().then(querySnapshot => {
            const deletePromises = [];
            querySnapshot.forEach(documentSnapshot => {
                deletePromises.push(documentSnapshot.ref.delete());
            });
            return Promise.all(deletePromises);
        });
    });

function updateSyllabusLessonCount(lessonId, firestoreRef, languageCode) {
    const lessonRef = firestoreRef.collection(`localized/${languageCode}/syllabus_lessons`).doc(lessonId);

    const topicsForLessonQuery = firestoreRef.collection(`localized/${languageCode}/topics`)
        .where(`syllabus_lessons.${lessonId}`, "==", true);

    return topicsForLessonQuery.get().then(function(querySnapshot) {
        let count = querySnapshot.size;
        return lessonRef.update({topicCount: count})
    });
}

exports.countTopicsForSyllabusLesson = functions.firestore.document('localized/{languageCode}/syllabus_lessons/{lessonId}')
    .onUpdate(event => {
        const lessonId = event.params.lessonId;
        const languageCode = event.params.languageCode;
        const firestoreRef = event.data.ref.firestore;

        return updateSyllabusLessonCount(lessonId, firestoreRef, languageCode);
    });

exports.countTopicsForSyllabusLessonOnTopicChange = functions.firestore.document('localized/{languageCode}/topics/{topicId}')
    .onWrite(event => {
        let oldSyllabusLessons = {};
        let newSyllabusLessons = {};

        if (event.data.previous && event.data.previous.data()["syllabus_lessons"]) {
            oldSyllabusLessons = event.data.previous.data()["syllabus_lessons"];
        }

        if (event.data.exists && event.data.data()["syllabus_lessons"]) {
            newSyllabusLessons = event.data.data()["syllabus_lessons"];
        }

        const languageCode = event.params.languageCode;
        const firestoreRef = event.data.ref.firestore;

        const writePromises = [];

        for (oldLessonId in oldSyllabusLessons) {
            writePromises.push(updateSyllabusLessonCount(oldLessonId, firestoreRef, languageCode))
        }

        for (newLessonId in newSyllabusLessons) {
            writePromises.push(updateSyllabusLessonCount(newLessonId, firestoreRef, languageCode))
        }

        return Promise.all(writePromises);
    });

exports.createUserInFirestore = functions.auth.user().onCreate(event => {
    const user = event.data;
    const displayName = user.displayName;
    const email = user.email;
    const phoneNumber = user.phoneNumber;

    const userObject = {};

    if (displayName) {
        userObject["displayName"] = displayName;
    }

    if (email) {
        userObject["email"] = email;
    }

    if (phoneNumber) {
        userObject["phoneNumber"] = phoneNumber;
    }

    const firestore = admin.firestore();
    const usersCollection = firestore.collection("users");

    return usersCollection.doc(user.uid).set(userObject)
});

exports.deleteUserFromFirestore = functions.auth.user().onDelete(event => {
    const user = event.data;

    const firestore = admin.firestore();
    const usersCollection = firestore.collection("users");

    return usersCollection.doc(user.uid).delete();
});

exports.onResourceStatusChange = functions.firestore.document('localized/{languageCode}/resources/{resourceId}')
    .onUpdate(event => {
        const resourceRef = event.data.ref;

        const oldStatus = event.data.previous.data()["status"];
        const newStatus = event.data.data()["status"];

        if (!oldStatus || !newStatus || oldStatus === newStatus) {
            return null;
        }

        const promises = [];

        // Lock all feedback for each card
        promises.push(lockAllCardFeedbackForResource(resourceRef));

        if (newStatus === "awaiting review" || newStatus === "published") {
            // When submitting a lesson for review or publishing, clear feedback previews
            promises.push(clearFeedbackPreviewsForAllCardsInResource(resourceRef));
        }

        return Promise.all(promises);
    });

function lockAllCardFeedbackForResource(resourceRef) {
    return resourceRef.collection("cards").get().then(querySnapshot => {
        const lockPromises = [];

        querySnapshot.forEach(documentSnapshot => {
            lockPromises.push(lockAllCardFeedback(documentSnapshot.ref));
        });

        return Promise.all(lockPromises);
    });

}

function lockAllCardFeedback(cardRef) {
    const feedbackCollectionRef = cardRef.collection("feedback");
    return feedbackCollectionRef.get().then(querySnapshot => {
        const lockPromises = [];
        querySnapshot.forEach(documentSnapshot => {
            lockPromises.push(setFeedbackToLocked(documentSnapshot.ref));
        });

        return Promise.all(lockPromises);
    });
}

function setFeedbackToLocked(feedbackRef) {
    return feedbackRef.update("locked", true);
}

function clearFeedbackPreviewsForAllCardsInResource(resourceRef) {
    return resourceRef.collection("cards").get().then(querySnapshot => {
        const clearPreviewPromises = [];

        querySnapshot.forEach(documentSnapshot => {
            clearPreviewPromises.push(clearFeedbackPreviewForCard(documentSnapshot.ref));
        });

        return Promise.all(clearPreviewPromises);
    });
}

function clearFeedbackPreviewForCard(cardRef) {
    const promises = [];
    promises.push(cardRef.update("feedbackPreviewComment", ""));
    promises.push(cardRef.update("feedbackPreviewCommentPath", ""));

    return Promise.all(promises);
}

exports.updateCardFeedbackPreview = functions.firestore.document('localized/{languageCode}/resources/{resourceId}/cards/{cardId}/feedback/{feedbackId}')
    .onWrite(event => {
        // Find latest reviewer feedback comment that is not locked and set it as card's preview
        const feedbackCollectionRef = event.data.ref.parent;
        const cardRef = event.data.ref.parent.parent;

        return feedbackCollectionRef.where("reviewerComment", "==", true)
            .where("locked", "==", false)
            .orderBy("dateUpdated", "desc")
            .get().then(querySnapshot => {
                const size = querySnapshot.size;

                if (size > 0) {
                    const commentRef = querySnapshot.docs[0].ref;
                    const comment = querySnapshot.docs[0].data();
                    return setCardFeedbackPreview(cardRef, comment["commentText"], commentRef)
                } else {
                    return removeCardFeedbackPreview(cardRef)
                }
        });
    });

function setCardFeedbackPreview(cardRef, commentText, commentRef) {
    const refPath = commentRef.path;
    return cardRef.update({
        feedbackPreviewComment: commentText,
        feedbackPreviewCommentPath: refPath
    });
}

function removeCardFeedbackPreview(cardRef) {
    return cardRef.update({
        feedbackPreviewComment: "",
        feedbackPreviewCommentPath: ""
    });
}